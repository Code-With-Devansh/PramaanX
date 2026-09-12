'use strict';

// Chaincode entry point. Fabric looks for `contracts` to know which Contract
// classes to expose. Keep this file thin — logic lives in lib/documentContract.
const DocumentContract = require('./lib/documentContract');

module.exports.DocumentContract = DocumentContract;
module.exports.contracts = [DocumentContract];
