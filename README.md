[![npm (scoped)](https://img.shields.io/npm/v/@destinationstransfers/passkit.svg)](https://www.npmjs.com/package/@destinationstransfers/passkit) [![codecov](https://codecov.io/gh/destinationstransfers/passkit/branch/master/graph/badge.svg)](https://codecov.io/gh/destinationstransfers/passkit)
[![Build Status](https://dev.azure.com/destinationstransfers/passkit/_apis/build/status/destinationstransfers.passkit?branchName=master)](https://dev.azure.com/destinationstransfers/passkit/_build/latest?definitionId=2&branchName=master)
[![Known Vulnerabilities](https://snyk.io/test/github/destinationstransfers/passkit/badge.svg)](https://snyk.io/test/github/destinationstransfers/passkit) [![DeepScan grade](https://deepscan.io/api/teams/2667/projects/4302/branches/35050/badge/grade.svg)](https://deepscan.io/dashboard#view=project&tid=2667&pid=4302&bid=35050) [![Reliability Rating](https://sonarcloud.io/api/project_badges/measure?project=destinationstransfers_passkit&metric=reliability_rating)](https://sonarcloud.io/dashboard?id=destinationstransfers_passkit) [![Lines of Code](https://sonarcloud.io/api/project_badges/measure?project=destinationstransfers_passkit&metric=ncloc)](https://sonarcloud.io/dashboard?id=destinationstransfers_passkit) [![Maintainability Rating](https://sonarcloud.io/api/project_badges/measure?project=destinationstransfers_passkit&metric=sqale_rating)](https://sonarcloud.io/dashboard?id=destinationstransfers_passkit) [![tested with jest](https://img.shields.io/badge/tested_with-jest-99424f.svg)](https://github.com/facebook/jest)

# @destinationstransfers/passkit

A Node (>= 10.x) module for generating Apple Wallet passes with localizations, NFC and web service push updates support.

# Get your certificates

To start with, you'll need a certificate issued by [the iOS Provisioning
Portal](https://developer.apple.com/ios/manage/passtypeids/index.action). You
need one certificate per Pass Type ID.

After adding this certificate to your Keychain, you need to export it as a
`.p12` file and copy it into the keys directory.

You will also need the [Apple Worldwide Developer Relations Certification
Authority](https://www.apple.com/certificateauthority/) certificate and to convert the `.p12` files into `.pem` files. You
can do both using the `passkit-keys` command:

```sh
./bin/passkit-keys ./pathToKeysFolder
```

This is the same directory into which you placed the `.p12` files.

# Start with a template

Start with a template. A template has all the common data fields that will be
shared between your passes, and also defines the keys to use for signing it.

```js
const { Template } = require("@destinationstransfers/passkit");

const template = new Template("coupon", {
  passTypeIdentifier: "pass.com.example.passbook",
  teamIdentifier: "MXL",
  backgroundColor: "red"
});

// or

const template = await Template.load(
  "./path/to/templateFolder",
  "secretKeyPasswod"
);
// .load will load all fields from pass.json,
// as well as all images and com.example.passbook.pem file as key
// and localized images too
```

The first argument is the pass style (`coupon`, `eventTicket`, etc), and the
second optional argument has any fields you want to set on the template.

You can access template fields directly, or from chained accessor methods, e.g:

```js
template.passTypeIdentifier = "pass.com.example.passbook";

console.log(template.passTypeIdentifier);

template.teamIdentifier = "MXL";
template.passTypeIdentifier = "pass.com.example.passbook";
```

The following template fields are required:
`passTypeIdentifier` - The Apple Pass Type ID, begins with "pass."
`teamIdentifier` - May contain an I

You can set any available fields either on a template or pass instance, such as: `backgroundColor`,
`foregroundColor`, `labelColor`, `logoText`, `organizationName`,
`suppressStripShine` and `webServiceURL`.

In addition, you need to tell the template where to find the key files and where
to load images from:

```js
await template.loadCertificate(
  "/etc/passbook/certificate_and_key.pem",
  "secret"
);
// or set them as strings
template.setCertificate(pemEncodedPassCertificate);
template.setPrivateKey(pemEncodedPrivateKey, optionalKeyPassword);

// if you didn't use Template.load then you can load images from any other folder:
await template.images.load("./images"); // loadFromDirectory returns Promise
```

The last part is optional, but if you have images that are common to all passes,
you may want to specify them once in the template.

# Create your pass

To create a new pass from a template:

```js
const pass = template.createPass({
  serialNumber: "123456",
  description: "20% off"
});
```

Just like template, you can access pass fields directly, e.g:

```js
pass.serialNumber = "12345";
console.log(pass.serialNumber);
pass.description = "20% off";
```

In the JSON specification, structure fields (primary fields, secondary fields,
etc) are represented as arrays, but items must have distinct key properties. Le
sigh.

To make it easier, you can use methods of standard Map object or `add` that
will do the logical thing. For example, to add a primary field:

```js
pass.primaryFields.add({ key: "time", label: "Time", value: "10:00AM" });
```

To get one or all fields:

```js
const dateField = pass.primaryFields.get("date");
for (const [key, { value }] of pass.primaryFields.entries()) {
  // ...
}
```

To remove one or all fields:

```js
pass.primaryFields.delete("date");
pass.primaryFields.clear();
```

Adding images to a pass is the same as adding images to a template:

```js
await pass.images.add("icon", iconFilename, "2x", "ru");

// following will load all appropriate images in all densities and localizations
await pass.images.load("./images");
```

You can add the image itself or a `Buffer`. Image format is enforced to be **PNG**.

# Localizations

This library fully supports both [string localization](https://developer.apple.com/library/archive/documentation/UserExperience/Conceptual/PassKit_PG/Creating.html#//apple_ref/doc/uid/TP40012195-CH4-SW54) and/or [images localization](https://developer.apple.com/library/archive/documentation/UserExperience/Conceptual/PassKit_PG/Creating.html#//apple_ref/doc/uid/TP40012195-CH4-SW1):

```js
// everything from template
// will load all localized images and strings from folders like ru.lproj/ or fr-CA.lproj/
await template.load(folderPath);

// Strings

pass.localizations
  .add("en-GB", {
    GATE: "GATE",
    DEPART: "DEPART",
    ARRIVE: "ARRIVE",
    SEAT: "SEAT",
    PASSENGER: "PASSENGER",
    FLIGHT: "FLIGHT"
  })
  .localizations.add("ru", {
    GATE: "ВЫХОД",
    DEPART: "ВЫЛЕТ",
    ARRIVE: "ПРИЛЁТ",
    SEAT: "МЕСТО",
    PASSENGER: "ПАССАЖИР",
    FLIGHT: "РЕЙС"
  });

// Images
await template.images.add(
  "logo" | "icon" | etc,
  imageFilePathOrBufferWithPNGdata,
  "1x" | "2x" | "3x" | undefined,
  "ru"
);
```

Localization applies for all fields' `label` and `value`. There is a note about that in [documentation](https://developer.apple.com/library/ios/documentation/UserExperience/Conceptual/PassKit_PG/Creating.html).

# Generate the file

To generate a file:

```js
async () => {
  const buf = await pass.asBuffer();
  await fs.writeFile("pathToPass.pass", buf);
};
```

You can sent the buffer directly to an HTTP server response:

```js
app.use(async (ctx, next) => {
  ctx.status = 200;
  ctx.type = passkit.constants.PASS_MIME_TYPE;
  ctx.body = await pass.asBuffer();
});
```

# Credits

This projects started as fork of [assaf/node-passbook](http://github.com/assaf/node-passbook).
Since version 5.0 our module is not API compatible, please see [Releases](https://github.com/destinationstransfers/passkit/releases) for more information.

- Targeting Node >= 10 and refactored in ES6 Classes, removing deprecated calls (`new Buffer`, etc)
- Replaces `openssl` spawning with native Javascript RSA implementation (via `node-forge`)
- Includes `Template.pushUpdates(pushToken)` that sends APN update request for a given pass type to a pushToken (get `pushToken` at your PassKit Web Service implementation)
- Adds constants for dictionary fields string values
- Migrated tests to Jest
- Increased test coverage
- Adds strict dictionary fields values validation (where possible) to prevent errors earlier
- Adding support for geolocation fields and Becon fields
- Adding easy template and localization load from JSON file
- We use it in production at [Transfers.do](https://transfers.do/)
