/**
 * Passbook are created from templates
 */

'use strict';

import * as http2 from 'http2';
import { join } from 'path';
import { promises as fs } from 'fs';

import * as forge from 'node-forge';

import { Pass } from './pass';
import { PASS_STYLES } from './constants';
import { PassStyle, ApplePass } from './interfaces';
import { PassBase } from './lib/base-pass';

import stripJsonComments = require('strip-json-comments');

const {
  HTTP2_HEADER_METHOD,
  HTTP2_HEADER_PATH,
  NGHTTP2_CANCEL,
  HTTP2_METHOD_POST,
} = http2.constants;
const { readFile, readdir } = fs;

// Create a new template.
//
// style  - Pass style (coupon, eventTicket, etc)
// fields - Pass fields (passTypeIdentifier, teamIdentifier, etc)
export class Template extends PassBase {
  key?: forge.pki.PrivateKey;
  certificate?: forge.pki.Certificate;
  private apn?: http2.ClientHttp2Session;
  /**
   *
   * @param {PassStyle} style
   * @param {{[k: string]: any }} [fields]
   */
  constructor(style?: PassStyle, fields: Partial<ApplePass> = {}) {
    super(fields);

    if (style) {
      if (!PASS_STYLES.has(style))
        throw new TypeError(`Unsupported pass style ${style}`);
      this.style = style;
    }
  }

  /**
   * Loads Template, images and key from a given path
   *
   * @static
   * @param {string} folderPath
   * @param {string} [keyPassword] - optional key password
   * @returns {Promise.<Template>}
   * @throws - if given folder doesn't contain pass.json or it is in invalid format
   * @memberof Template
   */
  // eslint-disable-next-line max-statements
  static async load(
    folderPath: string,
    keyPassword?: string,
  ): Promise<Template> {
    // Check if the path is accessible directory actually
    const entries = await readdir(folderPath, { withFileTypes: true });
    // getting main JSON file
    let template: Template | undefined;

    // read pass.json first to create template instance
    if (entries.find(entry => entry.isFile() && entry.name === 'pass.json')) {
      // loading main JSON file
      const jsonContent = await readFile(join(folderPath, 'pass.json'), 'utf8');
      const passJson = JSON.parse(stripJsonComments(jsonContent)) as Partial<
        ApplePass
      >;

      // Trying to detect the type of pass
      let type: PassStyle | undefined;
      for (const t of PASS_STYLES) {
        if (t in passJson) {
          type = t;
          break;
        }
      }
      if (!type) throw new TypeError('Unknown pass style!');
      template = new Template(type, passJson);
    } else template = new Template();
    const { passTypeIdentifier } = template;
    const keyName = passTypeIdentifier
      ? `${passTypeIdentifier.replace(/^pass\./, '')}.pem`
      : undefined;

    // checking rest of files
    const entriesLoader: Promise<void>[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        // check if it's a localization folder
        const test = /(?<lang>[-A-Z_a-z]+)\.lproj/.exec(entry.name);
        if (!test || !test.groups || !test.groups.lang) continue;
        const lang = template.localization.normalizeLang(test.groups.lang);
        // reading this directory
        const currentPath = join(folderPath, entry.name);
        const localizations = await readdir(currentPath, {
          withFileTypes: true,
        });
        // check if it has strings and load
        if (localizations.find(f => f.isFile() && f.name === 'pass.strings'))
          entriesLoader.push(
            template.localization.addFile(
              lang,
              join(currentPath, 'pass.strings'),
            ),
          );
        // check if we have any localized images
        for (const f of localizations) {
          const img = template.images.parseFilename(f.name);
          if (img)
            entriesLoader.push(
              template.images.add(
                img.imageType,
                join(currentPath, f.name),
                img.density,
                lang,
              ),
            );
        }
      } else {
        // check if it's a certificate/key
        if (entry.name === keyName) {
          // following will throw if file doesn't exists or can't be read
          entriesLoader.push(
            template.loadCertificate(join(folderPath, keyName), keyPassword),
          );
          continue;
        }
        // check it it's an image
        const img = template.images.parseFilename(entry.name);
        if (img)
          entriesLoader.push(
            template.images.add(
              img.imageType,
              join(folderPath, entry.name),
              img.density,
            ),
          );
      }
    }
    await Promise.all(entriesLoader);
    // done
    return template;
  }

  /**
   *
   * @param {string} signerKeyMessage
   * @param {string} [password]
   */
  setPrivateKey(signerKeyMessage: string, password?: string): void {
    this.key = forge.pki.decryptRsaPrivateKey(signerKeyMessage, password);
    if (!this.key)
      throw new Error(
        'Failed to decode provided private key. Invalid password?',
      );
  }

  /**
   *
   * @param {string} signerCertData - certificate and optional private key as PEM encoded string
   * @param {string} [password] - optional password to decode private key
   */
  setCertificate(signerCertData: string, password?: string): void {
    // the PEM file from P12 contains both, certificate and private key
    // getting signer certificate
    this.certificate = forge.pki.certificateFromPem(signerCertData);
    if (!this.certificate)
      throw new Error('Failed to decode provided certificate');

    // check if signerCertData also contains private key and use it
    const pemMessages = forge.pem.decode(signerCertData);

    // getting signer private key
    const signerKeyMessage = pemMessages.find(message =>
      message.type.includes('KEY'),
    );
    if (signerKeyMessage)
      this.setPrivateKey(forge.pem.encode(signerKeyMessage), password);
  }

  /**
   *
   * @param {string} signerPemFile - path to PEM file with certificate and private key
   * @param {string} password - private key decoding password
   */
  async loadCertificate(
    signerPemFile: string,
    password?: string,
  ): Promise<void> {
    // reading and parsing certificates
    const signerCertData = await readFile(signerPemFile, 'utf8');
    this.setCertificate(signerCertData, password);
  }

  /**
   *
   * @param {string} pushToken
   */
  async pushUpdates(pushToken: string): Promise<http2.IncomingHttpHeaders> {
    if (!this.key)
      throw new ReferenceError(
        `Set private key before trying to push pass updates`,
      );
    if (!this.certificate)
      throw new ReferenceError(
        `Set pass certificate before trying to push pass updates`,
      );
    // https://developer.apple.com/library/content/documentation/UserExperience/Conceptual/PassKit_PG/Updating.html
    if (!this.apn || this.apn.destroyed) {
      // creating APN Provider
      this.apn = http2.connect('https://api.push.apple.com:443', {
        key: forge.pki.privateKeyToPem(this.key),
        cert: forge.pki.certificateToPem(this.certificate),
      });
      // Events
      this.apn.once('goaway', () => {
        if (this.apn && !this.apn.destroyed) this.apn.destroy();
      });
      await new Promise((resolve, reject) => {
        if (!this.apn) throw new Error('APN was destroyed before connecting');
        this.apn.once('connect', resolve);
        this.apn.once('error', reject);
      });
      // Calling unref() on a socket will allow the program to exit if this is the only active socket in the event system
      this.apn.unref();
    }

    // sending to APN
    return new Promise((resolve, reject) => {
      if (!this.apn) throw new Error('APN was destroyed before connecting');
      const req = this.apn.request({
        [HTTP2_HEADER_METHOD]: HTTP2_METHOD_POST,
        [HTTP2_HEADER_PATH]: `/3/device/${encodeURIComponent(pushToken)}`,
      });

      // Cancel request after timeout
      req.setTimeout(5000, () => req.close(NGHTTP2_CANCEL));

      // Response handling
      req.on('response', headers => {
        // consuming data, even if we are not interesting in it
        req.on('data', () => {});
        req.once('end', () => resolve(headers));
      });

      // Error handling
      req.once('error', reject);
      req.once('timeout', () =>
        reject(new Error(`http2: timeout connecting to api.push.apple.com`)),
      );

      // Post payload (always empty in our case)
      req.end('{}');
    });
  }

  /**
   * Create a new pass from a template.
   *
   * @param {Object} fields
   * @returns {Pass}
   * @memberof Template
   */
  createPass(fields: Partial<ApplePass> = {}): Pass {
    // Combine template and pass fields
    return new Pass(
      this,
      { ...this.fields, ...fields },
      this.images,
      this.localization,
    );
  }
}
