'use strict';

const { createHash } = require('crypto');
const { createWriteStream, unlinkSync, mkdtempSync } = require('fs');
const { tmpdir } = require('os');
const path = require('path');
const { once } = require('events');
const { promisify } = require('util');
const pipeline = promisify(require('stream').pipeline);
const execFile = promisify(require('child_process').execFile);

const StreamZip = require('node-stream-zip');
const { WritableStreamBuffer } = require('stream-buffers');

const constants = require('../src/constants');
const Pass = require('../src/pass');
const Template = require('../src/template');

// Clone all the fields in object, except the named field, and return a new
// object.
//
// object - Object to clone
// field  - Except this field
function cloneExcept(object, field) {
  const clone = {};
  for (const key in object) {
    if (key !== field) clone[key] = object[key];
  }
  return clone;
}

async function unzip(zipFile, filename) {
  const zip = new StreamZip({
    file: zipFile,
    storeEntries: true,
  });

  // Handle errors
  zip.on('error', err => {
    throw err;
  });
  await once(zip, 'ready');
  const data = zip.entryDataSync(filename);
  zip.close();
  return data;
}

const template = new Template('coupon', {
  passTypeIdentifier: 'pass.com.example.passbook',
  teamIdentifier: 'MXL',
  labelColor: 'red',
});

const fields = {
  serialNumber: '123456',
  organizationName: 'Acme flowers',
  description: '20% of black roses',
};

describe('Pass', () => {
  beforeAll(async () => {
    template.setCertificate(process.env.APPLE_PASS_CERTIFICATE);
    template.setPrivateKey(
      process.env.APPLE_PASS_PRIVATE_KEY,
      process.env.APPLE_PASS_KEY_PASSWORD,
    );
  });
  it('from template', () => {
    const pass = template.createPass();

    // should copy template fields
    expect(pass.fields.passTypeIdentifier).toBe('pass.com.example.passbook');

    // should start with no images
    expect(pass.images.map.size).toBe(0);

    // should create a structure based on style
    expect(pass.fields.coupon).toBeDefined();
    expect(pass.fields.eventTicket).toBeUndefined();
  });

  it('getGeoPoint', () => {
    expect(Pass.getGeoPoint([14.235, 23.3444, 23.4444])).toMatchObject({
      longitude: expect.any(Number),
      latitude: expect.any(Number),
      altitude: expect.any(Number),
    });

    expect(() => Pass.getGeoPoint([14.235, 'brrrr', 23.4444])).toThrow();

    expect(Pass.getGeoPoint({ lat: 1, lng: 2, alt: 3 })).toMatchObject({
      longitude: 2,
      latitude: 1,
      altitude: 3,
    });

    expect(Pass.getGeoPoint({ longitude: 10, latitude: 20 })).toMatchObject({
      longitude: 10,
      latitude: 20,
      altitude: undefined,
    });

    expect(() => Pass.getGeoPoint({ lat: 1, log: 3 })).toThrow(
      'Unknown geopoint format',
    );
  });

  //
  it('barcodes as Array', () => {
    const pass = template.createPass(cloneExcept(fields, 'serialNumber'));
    expect(() =>
      pass.barcodes([
        {
          format: 'PKBarcodeFormatQR',
          message: 'Barcode message',
          messageEncoding: 'iso-8859-1',
        },
      ]),
    ).not.toThrow();
    expect(() => pass.barcodes('byaka')).toThrow();
  });

  it('without serial number should not be valid', () => {
    const pass = template.createPass(cloneExcept(fields, 'serialNumber'));
    expect(() => pass.validate()).toThrow('Missing field serialNumber');
  });

  it('without organization name should not be valid', () => {
    const pass = template.createPass(cloneExcept(fields, 'organizationName'));
    expect(() => pass.validate()).toThrow('Missing field organizationName');
  });

  it('without description should not be valid', () => {
    const pass = template.createPass(cloneExcept(fields, 'description'));
    expect(() => pass.validate()).toThrow('Missing field description');
  });

  it('without icon.png should not be valid', () => {
    const pass = template.createPass(fields);
    expect(() => pass.validate()).toThrow('Missing required image icon.png');
  });

  it('without logo.png should not be valid', async () => {
    const pass = template.createPass(fields);
    pass.images.icon = 'icon.png';
    const file = new WritableStreamBuffer();

    const validationError = await new Promise(resolve => {
      pass.pipe(file);
      pass.on('done', () => {
        throw new Error('Expected validation error');
      });
      pass.on('error', resolve);
    });

    expect(validationError).toHaveProperty(
      'message',
      'Missing required image logo.png',
    );
  });

  it('boarding pass has string-only property in structure fields', async () => {
    const templ = await Template.load(
      path.resolve(__dirname, './resources/passes/BoardingPass.pass/'),
    );
    expect(templ.style).toBe('boardingPass');
    // switching transit type
    const pass = templ.createPass();
    expect(pass.transitType()).toBe(constants.TRANSIT.AIR);
    pass.transitType(constants.TRANSIT.BUS);
    expect(pass.transitType()).toBe(constants.TRANSIT.BUS);
    expect(pass.getPassJSON().boardingPass).toHaveProperty(
      'transitType',
      constants.TRANSIT.BUS,
    );
  });

  it('stream', async () => {
    const pass = template.createPass(fields);
    await pass.images.loadFromDirectory(path.resolve(__dirname, './resources'));
    pass.headerFields.add('date', 'Date', 'Nov 1');
    pass.primaryFields.add([
      { key: 'location', label: 'Place', value: 'High ground' },
    ]);
    const tmd = mkdtempSync(`${tmpdir()}${path.sep}`);
    const passFileName = path.join(tmd, 'pass.pkpass');
    await pipeline(pass.stream(), createWriteStream(passFileName));
    // test that result is valid ZIP at least
    const { stdout } = await execFile('unzip', ['-t', passFileName]);
    unlinkSync(passFileName);
    expect(stdout).toContain('No errors detected in compressed data');
  });
});

describe('generated', () => {
  const pass = template.createPass(fields);
  const tmd = mkdtempSync(`${tmpdir()}${path.sep}`);
  const passFileName = path.join(tmd, 'pass.pkpass');

  beforeAll(async () => {
    jest.setTimeout(100000);
    await pass.images.loadFromDirectory(path.resolve(__dirname, './resources'));
    pass.headerFields.add('date', 'Date', 'Nov 1');
    pass.primaryFields.add([
      { key: 'location', label: 'Place', value: 'High ground' },
    ]);
    await pipeline(pass.stream(), createWriteStream(passFileName));
  });

  afterAll(async () => {
    unlinkSync(passFileName);
  });

  it('should be a valid ZIP', async () => {
    const { stdout } = await execFile('unzip', ['-t', passFileName]);
    expect(stdout).toContain('No errors detected in compressed data');
  });

  it('should contain pass.json', async () => {
    const res = JSON.parse(await unzip(passFileName, 'pass.json'));

    expect(res).toMatchObject({
      passTypeIdentifier: 'pass.com.example.passbook',
      teamIdentifier: 'MXL',
      serialNumber: '123456',
      organizationName: 'Acme flowers',
      description: '20% of black roses',
      coupon: {
        headerFields: [
          {
            key: 'date',
            label: 'Date',
            value: 'Nov 1',
          },
        ],
        primaryFields: [
          {
            key: 'location',
            label: 'Place',
            value: 'High ground',
          },
        ],
      },
      formatVersion: 1,
    });
  });

  it('should contain a manifest', async () => {
    const res = JSON.parse(await unzip(passFileName, 'manifest.json'));
    expect(res).toMatchObject({
      'pass.json': expect.any(String), // '87c2bd96d4bcaf55f0d4d7846a5ae1fea85ea628',
      'icon.png': 'e0f0bcd503f6117bce6a1a3ff8a68e36d26ae47f',
      'icon@2x.png': '10e4a72dbb02cc526cef967420553b459ccf2b9e',
      'logo.png': 'abc97e3b2bc3b0e412ca4a853ba5fd90fe063551',
      'logo@2x.png': '87ca39ddc347646b5625062a349de4d3f06714ac',
      'strip.png': '68fc532d6c76e7c6c0dbb9b45165e62fbb8e9e32',
      'strip@2x.png': '17e4f5598362d21f92aa75bc66e2011a2310f48e',
      'thumbnail.png': 'e199fc0e2839ad5698b206d5f4b7d8cb2418927c',
      'thumbnail@2x.png': 'ac640c623741c0081fb1592d6353ebb03122244f',
    });
  });

  // this test depends on MacOS specific signpass, so, run only on MacOS
  if (process.platform === 'darwin') {
    it('should contain a signature', async () => {
      const { stdout, stderr } = await execFile(
        path.resolve(__dirname, './resources/bin/signpass'),
        ['-v', passFileName],
      );
      expect(stdout).toContain('*** SUCCEEDED ***');
    });
  }

  it('should contain the icon', async () => {
    const buffer = await unzip(passFileName, 'icon.png');
    expect(
      createHash('sha1')
        .update(buffer)
        .digest('hex'),
    ).toBe('e0f0bcd503f6117bce6a1a3ff8a68e36d26ae47f');
  });

  it('should contain the logo', async () => {
    const buffer = await unzip(passFileName, 'logo.png');
    expect(
      createHash('sha1')
        .update(buffer)
        .digest('hex'),
    ).toBe('abc97e3b2bc3b0e412ca4a853ba5fd90fe063551');
  });
});
