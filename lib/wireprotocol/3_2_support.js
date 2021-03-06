"use strict";

var Insert = require('./commands').Insert
  , Update = require('./commands').Update
  , Remove = require('./commands').Remove
  , Query = require('../connection/commands').Query
  , copy = require('../connection/utils').copy
  , KillCursor = require('../connection/commands').KillCursor
  , GetMore = require('../connection/commands').GetMore
  , Query = require('../connection/commands').Query
  , ReadPreference = require('../topologies/read_preference')
  , f = require('util').format
  , CommandResult = require('../topologies/command_result')
  , MongoError = require('../error')
  , Long = require('bson').Long;

var WireProtocol = function() {}

//
// Execute a write operation
var executeWrite = function(topology, type, opsField, ns, ops, options, callback) {
  if(ops.length == 0) throw new MongoError("insert must contain at least one document");
  if(typeof options == 'function') {
    callback = options;
    options = {};
  }

  // Split the ns up to get db and collection
  var p = ns.split(".");
  var d = p.shift();
  // Options
  var ordered = typeof options.ordered == 'boolean' ? options.ordered : true;
  var writeConcern = options.writeConcern || {};
  // return skeleton
  var writeCommand = {};
  writeCommand[type] = p.join('.');
  writeCommand[opsField] = ops;
  writeCommand.ordered = ordered;
  writeCommand.writeConcern = writeConcern;    

  // Options object
  var opts = {};
  if(type == 'insert') opts.checkKeys = true;
  // Ensure we support serialization of functions
  if(options.serializeFunctions) opts.serializeFunctions = options.serializeFunctions;
  // Execute command
  topology.command(f("%s.$cmd", d), writeCommand, opts, callback);    
}

//
// Needs to support legacy mass insert as well as ordered/unordered legacy
// emulation
//
WireProtocol.prototype.insert = function(topology, ismaster, ns, bson, pool, callbacks, ops, options, callback) {
  executeWrite(topology, 'insert', 'documents', ns, ops, options, callback);
}

WireProtocol.prototype.update = function(topology, ismaster, ns, bson, pool, callbacks, ops, options, callback) {    
  executeWrite(topology, 'update', 'updates', ns, ops, options, callback);
}  

WireProtocol.prototype.remove = function(topology, ismaster, ns, bson, pool, callbacks, ops, options, callback) {
  executeWrite(topology, 'delete', 'deletes', ns, ops, options, callback);
}

WireProtocol.prototype.killCursor = function(bson, cursorId, connection, callback) {
  // Create a kill cursor command
  var killCursor = new KillCursor(bson, [cursorId]);
  // Execute the kill cursor command
  if(connection && connection.isConnected()) connection.write(killCursor.toBin());
  // Set cursor to 0
  cursorId = Long.ZERO;
  // Return to caller
  if(callback) callback(null, null);
}

WireProtocol.prototype.getMore = function(bson, ns, cursorState, batchSize, raw, connection, callbacks, options, callback) {
  var readPreference = options.readPreference || new ReadPreference('primary');
  if(typeof readPreference == 'string') readPreference = new ReadPreference(readPreference);
  if(!(readPreference instanceof ReadPreference)) throw new MongoError('readPreference must be a ReadPreference instance');
  // Build command namespace
  var parts = ns.split(/\./);
  // Command namespace
  var commandns = f('%s.$cmd', parts.shift());

  // Check if we have an maxTimeMS set
  var maxTimeMS = typeof cursorState.cmd.maxTimeMS == 'number' ? cursorState.cmd.maxTimeMS : 3000;

  // Create getMore command
  var getMoreCmd = {
    getMore: cursorState.cursorId,
    collection: parts.join('.'),
    batchSize: batchSize,
    maxTimeMS: maxTimeMS
  }

  // Build Query object
  var query = new Query(bson, commandns, getMoreCmd, {
      numberToSkip: 0, numberToReturn: -1
    , checkKeys: false, returnFieldSelector: null
  });

  // Set query flags
  query.slaveOk = readPreference.slaveOk();

  // Query callback
  var queryCallback = function(err, r) {
    if(err) return callback(err);
    if(!Array.isArray(r.documents) || r.documents.length == 0) 
      return callback(new MongoError(f('invalid getMore result returned for cursor id %s', cursorState.cursorId)));
    
    // Set all the values
    cursorState.documents = r.documents[0].cursor.nextBatch;
    cursorState.cursorId = r.documents[0].cursor.id;
    // Return the result
    callback(null, r.documents[0]);
  }

  // Register a callback
  callbacks.register(query.requestId, queryCallback);
  // Write out the getMore command
  connection.write(query.toBin());
}

WireProtocol.prototype.command = function(bson, ns, cmd, cursorState, topology, options) {
  // Establish type of command
  if(cmd.find) {
    return executeFindCommand(bson, ns, cmd, cursorState, topology, options)
  } else if(cursorState.cursorId != null) {
  } else if(cmd) {
    return setupCommand(bson, ns, cmd, cursorState, topology, options);
  } else {
    throw new MongoError(f("command %s does not return a cursor", JSON.stringify(cmd)));
  }
}

// // Command
// {
//     find: ns
//   , query: <object>
//   , limit: <n>
//   , fields: <object>
//   , skip: <n>
//   , hint: <string>
//   , explain: <boolean>
//   , snapshot: <boolean>
//   , batchSize: <n>
//   , returnKey: <boolean>
//   , maxScan: <n>
//   , min: <n>
//   , max: <n>
//   , showDiskLoc: <boolean>
//   , comment: <string>
//   , maxTimeMS: <n>
//   , raw: <boolean>
//   , readPreference: <ReadPreference>
//   , tailable: <boolean>
//   , oplogReplay: <boolean>
//   , noCursorTimeout: <boolean>
//   , awaitdata: <boolean>
//   , exhaust: <boolean>
//   , partial: <boolean>
// }

// FIND/GETMORE SPEC
// {
//     “find”: <string>,
//     “filter”: { ... },
//     “sort”: { ... },
//     “projection”: { ... },
//     “hint”: { ... },
//     “skip”: <int>,
//     “limit”: <int>,
//     “batchSize”: <int>,
//     “singleBatch”: <bool>,
//     “comment”: <string>,
//     “maxScan”: <int>,
//     “maxTimeMS”: <int>,
//     “max”: { ... },
//     “min”: { ... },
//     “returnKey”: <bool>,
//     “showRecordId”: <bool>,
//     “snapshot”: <bool>,
//     “tailable”: <bool>,
//     “oplogReplay”: <bool>,
//     “noCursorTimeout”: <bool>,
//     “awaitData”: <bool>,
//     “partial”: <bool>,
//     “$readPreference”: { ... }
// }

//
// Execute a find command
var executeFindCommand = function(bson, ns, cmd, cursorState, topology, options) {
  var readPreference = options.readPreference || new ReadPreference('primary');
  if(typeof readPreference == 'string') readPreference = new ReadPreference(readPreference);
  if(!(readPreference instanceof ReadPreference)) throw new MongoError('readPreference must be a ReadPreference instance');

  // Ensure we have at least some options
  options = options || {};
  // Set the optional batchSize
  cursorState.batchSize = cmd.batchSize || cursorState.batchSize;

  // Build command namespace
  var parts = ns.split(/\./);
  // Command namespace
  var commandns = f('%s.$cmd', parts.shift());

  // Build actual find command
  var findCmd = {
    find: parts.join('.')
  };

  // I we provided a filter
  if(cmd.query) findCmd.filter = cmd.query;  
  // Add sort to command
  if(cmd.sort) findCmd.sort = cmd.sort;
  // Add a projection to the command
  if(cmd.fields) findCmd.projection = cmd.fields;
  // Add a hint to the command
  if(cmd.hint) findCmd.hint = cmd.hint;
  // Add a skip
  if(cmd.skip) findCmd.skip = cmd.skip;
  // Add a limit
  if(cmd.limit) findCmd.limit = cmd.limit;
  // Add a batchSize
  if(cmd.batchSize) findCmd.batchSize = cmd.batchSize;

  // Check if we wish to have a singleBatch
  if(cmd.limit < 0) {
    cmd.limit = Math.abs(cmd.limit);
    cmd.singleBatch = true;
  }

  // If we have comment set
  if(cmd.comment) findCmd.comment = cmd.comment;
  
  // If we have maxScan
  if(cmd.maxScan) findCmd.maxScan = cmd.maxScan;
  
  // If we have maxTimeMS set
  if(cmd.maxTimeMS) findCmd.maxTimeMS = cmd.maxTimeMS;
  
  // If we have min
  if(cmd.min) findCmd.min = cmd.min;
  
  // If we have max
  if(cmd.max) findCmd.max = cmd.max;
  
  // If we have returnKey set
  if(cmd.returnKey) findCmd.returnKey = cmd.returnKey;
  
  // If we have showDiskLoc set
  if(cmd.showDiskLoc) findCmd.showRecordId = cmd.showDiskLoc;

  // If we have snapshot set
  if(cmd.snapshot) findCmd.snapshot = cmd.snapshot;

  // If we have tailable set
  if(cmd.tailable) findCmd.tailable = cmd.tailable;

  // If we have oplogReplay set
  if(cmd.oplogReplay) findCmd.oplogReplay = cmd.oplogReplay;

  // If we have noCursorTimeout set
  if(cmd.noCursorTimeout) findCmd.noCursorTimeout = cmd.noCursorTimeout;

  // If we have awaitData set
  if(cmd.awaitData) findCmd.awaitData = cmd.awaitData;
  if(cmd.awaitdata) findCmd.awaitData = cmd.awaitdata;

  // If we have partial set
  if(cmd.partial) findCmd.partial = cmd.partial;

  // Set query flags
  findCmd.slaveOk = readPreference.slaveOk();

  // We have a Mongos topology, check if we need to add a readPreference
  if(topology.type == 'mongos' && readPreference) {
    findCmd['$readPreference'] = readPreference.toJSON();
  }

  // If we have explain, we need to rewrite the find command
  // to wrap it in the explain command
  if(cmd.explain) {
    findCmd = {
      explain: findCmd
    }
  }

  // Build Query object
  var query = new Query(bson, commandns, findCmd, {
      numberToSkip: 0, numberToReturn: -1
    , checkKeys: false, returnFieldSelector: null
  });

  // Set query flags
  query.slaveOk = readPreference.slaveOk();

  // Return the query
  return query;
}  

//
// Set up a command cursor
var setupCommand = function(bson, ns, cmd, cursorState, topology, options) {
  var readPreference = options.readPreference || new ReadPreference('primary');
  if(typeof readPreference == 'string') readPreference = new ReadPreference(readPreference);
  if(!(readPreference instanceof ReadPreference)) throw new MongoError('readPreference must be a ReadPreference instance');

  // Set empty options object
  options = options || {}

  // Final query
  var finalCmd = {};
  for(var name in cmd) {
    finalCmd[name] = cmd[name];
  }

  // Build command namespace
  var parts = ns.split(/\./);

  // We have a Mongos topology, check if we need to add a readPreference
  if(topology.type == 'mongos' && readPreference) {
    finalCmd['$readPreference'] = readPreference.toJSON();
  }

  // Build Query object
  var query = new Query(bson, f('%s.$cmd', parts.shift()), finalCmd, {
      numberToSkip: 0, numberToReturn: -1
    , checkKeys: false
  });

  // Set query flags
  query.slaveOk = readPreference.slaveOk();

  // Return the query
  return query;
}

/**
 * @ignore
 */
var bindToCurrentDomain = function(callback) {
  var domain = process.domain;
  if(domain == null || callback == null) {
    return callback;
  } else {
    return domain.bind(callback);
  }
}

module.exports = WireProtocol;