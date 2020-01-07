const Controller = require('./controller');
const SerialPort = require('serialport');
const XError = require('xerror');
const pasync = require('pasync');
const GcodeLine = require('../../lib/gcode-line');
const AbbrJSON = require('./tinyg-abbr-json');
const CrispHooks = require('crisphooks');


/**
 * This is the controller interface class for TinyG.
 *
 * This class can be roughly separated into a few interconnected parts:
 * 1. Code for communicating with the TinyG
 * 2. Code for maintaining a local copy of machine state as closely as possible
 * 3. Utility functions for specific operations and implementations of the base class
 *
 * The communications algorithms is basically this:
 * - A sendQueue is stored.  This contains not only entries that have yet to be sent, but also entries that have been sent but not yet executed.  Each entry
 *   corresponds to a gcode line (or other single-line instruction) and contains some metadata relating to the line (including hooks).
 * - Several "pointers" into the sendQueue are maintained.  These are properties pointing to an index in the sendQueue.  These are:
 *   - The index into sendQueue of the next entry to send, but hasn't been sent yet.  This can be equal to the length of the array to indicate there are no
 *     currently queued entries to send. (sendQueueIdxToSend)
 *   - The index into the sendQueue of the next entry for which a response is expected.  If this is equal to sendQueueIdxToSend, then there
 *     have been no entries sent for which we've received no response. (sendQueueIdxToReceive)
 *   - The value of sendQueueIdxToReceive at the time we received the most recent (triple) queue report.  This is used to track which entries in the
 *     device's planner queue correspond to the entries in sendQueue. (sendQueueIdxToRecvAtLastQr)
 * - These pointers must be maintained to "track" the proper entries whenever something is spliced into or removed from the queue.
 * - Additionally, a "mirror" copy of the device's expected planner queue is maintained.  This plannerMirror contains entries corresponding to entries
 *   in the device's planner queue (based on queue reports), each containing a range of gcode lines (in sendQueue) that could have resulted in that planner
 *   queue entry.  This is needed because queue report synchronization may not be 100% deterministic.
 * - When a response is received for a request, the response hooks are executed, and sendQueueIdxToReceive is incremented.
 * - When a (triple) queue report is received, the information in qi and qo is used to push and pop entries off of plannerMirror.  Entries popped off the front
 *   are ones that have completed execution.  Entries pushed on the back correspond to gcode lines for which responses have been received since the last queue report.
 * - More data is sent when there are enough free buffers between the planner queue and the serial receive buffer.  This is tracked by storing the number of free planner buffers
 *   returned since the last queue report and deducting buffers based on how many responses we have yet to receive since the last queue report.
 *
 * @class TinyGController
 */
class TinyGController extends Controller {

	constructor(config = {}) {
		super(config);
		this.serial = null; // Instance of SerialPort stream interface class

		// This send queue serves multiple different purposes.  It contains entries that have not yet been sent, entries that have been sent but have not yet had responses
		// received, and entries that have had responses received but are still in the device's planner queue.  Entries in this queue are objects with several properties:
		// - str - The string of the raw line to send.  Should not include newline at end.
		// - hooks - Optional instance of CrispHooks.  If exists, the following hooks are called:
		//   - queued - When the entry is first pushed onto the send queue.
		//   - sent - When the entry is sent to the controller.
		//   - ack - When the controller acknowledges that it received the line.
		//   - executing - (Approximately) when the line begins to execute.
		//   - executed - (Approximately) when the line has been executed.  For control lines and some gcode lines, this is at the same time as ack.  For movement and other
		//     gcode lines, this is fired when it has been estimated to have cleared the planner queue.
		//   - error - If an error occurs prior to the line being executed.
		// - lineid - A generated absolute line ID that increments and does not reset.  This is not the same as a gcode line number.
		// - gcode - If this is gcode, a GcodeLine instance representing this line.
		// - goesToPlanner - A boolean value that indicates how many entries this is expected to take on the planner queue (round up to highest estimate)
		// - responseExpected - If an ack is expected from the device
		// Note that the sendQueue does not contain "front panel control" instructions like feed hold, as these are sent and processed immediately, and give no feedback.
		this.sendQueue = [];
		// This is the index into sendQueue of the next entry to send to the device.  Can be 1 past the end of the queue if there are no lines queued to be sent.
		this.sendQueueIdxToSend = 0;
		// This is the index into sendQueue of the next entry that has been sent but a response is expected for.
		this.sendQueueIdxToReceive = 0;
		// This array mirrors the device's planner queue.  Each entry is a range [ low, high ] (inclusive) of 0 or more gcode line ids that we think correspond to
		// that planner queue entry (such that the gcode line's execute hook will fire after it's pushed off the planner queue).
		this.plannerMirror = [];
		// This is the value of sendQueueIdxToReceive at the time that the more recent queue report was received (adjusted for shifting off the front of the queue)
		this.sendQueueIdxToRecvAtLastQr = 0;
		// Number of planner queue buffers free as off last received queue report
		this.lastQrNumFree = 28;
		// Number of blocks in sendQueue to send immediately even if it would exceed normal backpressure
		this.sendImmediateCounter = 0;

		// Counter storing the next free line id to use
		this.lineIdCounter = 1;

		this.resetOnConnect = false;

		this.synced = true;

		this.axisLabels = [ 'x', 'y', 'z', 'a', 'b', 'c' ];
		this.usedAxes = config.usedAxes || [ true, true, true, false, false, false ];
		this.homableAxes = config.homableAxes || [ true, true, true ];
		this.axisMaxFeeds = [ 500, 500, 500, 500, 500, 500 ]; // initial values, set later during initialization

		this._waitingForSync = false;
		this._disableSending = false; // flag to disable sending data using normal channels (_sendImmediate still works)
		this._disableResponseErrorEvent = false; // flag to disable error events in cases where errors are expected
		this.currentStatusReport = {};
		this.plannerQueueSize = 28; // Total size of planner queue
		this.plannerQueueFree = 28; // Number of buffers in the tinyg planner queue currently open

		this.realTimeMovesTimeStart = [ 0, 0, 0, 0, 0, 0 ];
		this.realTimeMovesCounter = [ 0, 0, 0, 0, 0, 0 ];

		this._serialListeners = {}; // mapping from serial port event names to listener functions; used to remove listeners during cleanup
	}

	debug(str) {
		const enableDebug = false;
		if (this.tightcnc) this.tightcnc.debug('TinyG: ' + str);
		else if (enableDebug) console.log('Debug: ' + str);
	}

	// Resets all the communications-related state variables, and errors out any in-flight requests
	_commsReset(err = null) {
		this.debug('_commsReset()');
		if (!err) err = new XError(XError.INTERNAL_ERROR, 'Communications reset');
		// Call the error hook on anything in sendQueue
		for (let entry of this.sendQueue) {
			if (entry.hooks) {
				this.debug('_commsReset triggering error hook on sendQueue entry');
				entry.hooks.triggerSync('error', err);
			}
		}
		this.debug('_commsReset() done triggering error hooks');
		// Reset all the variables
		this.sendQueue = [];
		this.sendQueueIdxToSend = 0;
		this.sendQueueIdxToReceive = 0;
		this.plannerMirror = [];
		this.sendQueueIdxToRecvAtLastQr = 0;
		this.lastQrNumFree = 28;
	}

	// Calls executing hooks corresponding to front entry in planner mirror
	_commsCallExecutingHooks(minLineId = -1) {
		//this.debug('_commsCallExecutingHooks() ' + minLineId);
		let lineidRange = this.plannerMirror[0];
		if (lineidRange) {
			let topLineId = lineidRange[1]; // max line id inclusive
			// Call hook on each line in the send queue until we've exceeded the top line id
			let sqIdx = 0;
			while (sqIdx < this.sendQueue.length && this.sendQueue[sqIdx].lineid <= topLineId) {
				let sqEntry = this.sendQueue[sqIdx];
				sqIdx++;
				// run hooks if present
				if (sqEntry.hooks && sqEntry.lineid >= minLineId) {
					sqEntry.hooks.triggerSync('executing', sqEntry);
				}
			}
		}
	}

	// Removes everything in plannerMirror, resolving all the hooks for entries in it
	// Used in (apparently frequent) cases of desyncs
	_commsSyncPlannerMirror() {
		//this.debug('_commsSyncPlannerMirror()');
		// shift everything off the planner queue
		while (this.plannerMirror.length > 0) {
			this._commsShiftPlannerMirror();
		}
		// if there's anything left in sendQueue that never made its way onto the planner queue after being acked (ie, no qr was received after), handle that
		if (this.sendQueueIdxToReceive > 0) {
			this.plannerMirror.push([ this.sendQueue[0].lineid, this.sendQueue[this.sendQueueIdxToReceive - 1].lineid ]);
			this._commsCallExecutingHooks();
			this._commsShiftPlannerMirror();
		}
	}

	// Marks the front entry of the planner queue as executed and shifts it off the queue
	_commsShiftPlannerMirror() {
		//this.debug('_commsShiftPlannerMirror() plannerMirror.length ' + this.plannerMirror.length);
		// Shift off the front entry of the planner queue, and handle each line id range
		let lineidRange = this.plannerMirror.shift();
		if (lineidRange) {
			let topLineId = lineidRange[1]; // max line id to "resolve", inclusive
			//this.debug('Shifted top line id ' + topLineId);
			// Resolve each line in the send queue until we've exceeded the top line id
			while (this.sendQueue.length > 0 && this.sendQueue[0].lineid <= topLineId) {
				//this.debug('shifting sendQueue');
				let sqEntry = this.sendQueue.shift();
				// run hooks if present
				if (sqEntry.hooks) {
					sqEntry.hooks.triggerSync('executed', sqEntry);
				}
				// adjust pointers after shifting
				this.sendQueueIdxToSend--;
				this.sendQueueIdxToReceive--;
				this.sendQueueIdxToRecvAtLastQr--;
				if (this.sendQueueIdxToRecvAtLastQr < 0) this.sendQueueIdxToRecvAtLastQr = 0;
			}
		}
		// Call executing hooks corresponding to next planner queue entry
		if (this.plannerMirror.length > 0) {
			//this.debug('calling executing hooks');
			this._commsCallExecutingHooks();
		}
		//this.debug('end _commsShiftPlannerMirror()');
	}

	// Communications-related code for when a queue report is received from the device
	_commsHandleQueueReportReceived(queueReport) {
		//this.debug('_commsHandleQueueReportReceived()');
		let { qr, qi, qo } = queueReport;
		// --- HANDLE qi ---
		// For each entry pushed onto the planner since the last report, push onto the mirror planner.
		// Each of these entries should correspond to 0 or more gcode line IDs.
		// The range of gcode lines in the queue that correspond to this range of qi is sendQueueIdxToRecvAtLastQr (inclusive) to sendQueueIdxToReceive (exclusive)
		//this.debug('qi pushes');
		let sendQueueIdxRangeStart = this.sendQueueIdxToRecvAtLastQr;
		let sendQueueIdxRangeEnd = this.sendQueueIdxToReceive;
		for (let qiCtr = 0; qiCtr < qi; qiCtr++) {
			let qisLeft = qi - qiCtr;
			let sendQueuesLeft = sendQueueIdxRangeEnd - sendQueueIdxRangeStart;
			let numGcodesThisQi = Math.floor(sendQueuesLeft / qisLeft);
			if (numGcodesThisQi === 0) {
				this.plannerMirror.push(null);
				continue;
			}
			let lineIdStart = this.sendQueue[sendQueueIdxRangeStart].lineid;
			let lineIdEnd = this.sendQueue[sendQueueIdxRangeStart + numGcodesThisQi - 1].lineid;
			this.plannerMirror.push([ lineIdStart, lineIdEnd ]);
			if (this.plannerMirror.length === 1) {
				this._commsCallExecutingHooks();
			}
			sendQueueIdxRangeStart += numGcodesThisQi;
		}
		// Edge case (shouldn't really happen) for if qi is 0 (no entries pushed onto the planner queue since last queue report)
		// but there have been responses received since the last queue report.  In this case, the gcode lines get "skipped"
		// by the above code.
		let shiftPlannerMirrorExtra = 0;
		if (qi < 1 && sendQueueIdxRangeEnd > sendQueueIdxRangeStart) {
			//this.debug('handle extra responses');
			let lineIdStart = this.sendQueue[sendQueueIdxRangeStart].lineid;
			let lineIdEnd = this.sendQueue[sendQueueIdxRangeEnd - 1].lineid;
			if (this.plannerMirror.length > 1) {
				// Combine it with the range of the most recent entry pushed onto plannerMirror
				if (this.plannerMirror[this.plannerMirror.length - 1]) {
					let pmentry = this.plannerMirror[this.plannerMirror.length - 1];
					if (pmentry[1] < lineIdEnd) {
						pmentry[1] = lineIdEnd;
					}
					// call executing hooks if first in queue (minLineId is passed here to prevent calling the executing hook again on existing members)
					if (this.plannerMirror.length === 1) this._commsCallExecutingHooks(lineIdStart);
				} else {
					this.plannerMirror[this.plannerMirror.length - 1] = [ lineIdStart, lineIdEnd ];
					// call executing hooks if first in queue
					if (this.plannerMirror.length === 1) this._commsCallExecutingHooks();
				}
			} else {
				// There's no planner queue mirror entry to associate these with, so add one.  This will cause
				// plannerMirror to become desynced from the qis and qos, so also shift an additional entry off later.
				this.plannerMirror.push([ lineIdStart, lineIdEnd ]);
				shiftPlannerMirrorExtra++;
				// call executing hooks if first in queue
				if (this.plannerMirror.length === 1) this._commsCallExecutingHooks();
			}
		}

		// --- HANDLE qo ---
		// For each entry pulled off the planner queue:
		// - Run the executed hook for any gcode line ids corresponding to that entry at the front of sendQueue; and shift off each of those gcode entries
		// - Shift it off our planner queue mirror
		// - Update the various indexes into sendQueue
		//this.debug('qo shifts');
		let plannerEntriesToShift = qo + shiftPlannerMirrorExtra;
		// Make sure we're not shifting off more than the total size of our planner queue
		if (plannerEntriesToShift > this.plannerMirror.length) plannerEntriesToShift = this.plannerMirror.length;
		while (plannerEntriesToShift > 0) {
			this._commsShiftPlannerMirror();
			plannerEntriesToShift--;
		}
		// Shift even more if qi/qo have gotten desynced from the actual planner queue fill
		//this.debug('handle possible planner queue desync');
		let plannerQueueFill = this.plannerQueueSize - qr;
		if (plannerQueueFill < 0) plannerQueueFill = 0;
		while (this.plannerMirror.length > plannerQueueFill) {
			this._commsShiftPlannerMirror();
		}

		// Store qr so we know how many free queue entries there are
		this.lastQrNumFree = qr;
		// Update this pointer
		this.sendQueueIdxToRecvAtLastQr = this.sendQueueIdxToReceive;
		// See if we can send more stuff
		this._checkSendLoop();
	}

	// Communications-related code for when a {r:...} response is received from the device
	// Should be called with the full response line (ie, it should contain a property 'r')
	_commsHandleAckResponseReceived(r) {
		//this.debug('_commsHandleAckResponseReceived()');
		// Make sure we're actually expecting a response.  If not, assume it's a bug (like with probing) and just
		// ignore the response.
		if (this.sendQueueIdxToSend <= this.sendQueueIdxToReceive) return;
		let responseStatusCode = r.f ? r.f[1] : 0;
		// Fire off the ack hook
		let entry = this.sendQueue[this.sendQueueIdxToReceive];
		if (entry.hooks) entry.hooks.triggerSync('ack', entry, r);
		if (responseStatusCode === 0) {
			// If we're not expecting this to go onto the planner queue, splice it out of the list now.  Otherwise,
			// increment the receive pointer.
			const everythingToPlanner = true; // makes gline hooks execute in order
			if (entry.goesToPlanner || everythingToPlanner) {
				this.sendQueueIdxToReceive++;
			} else {
				this.sendQueue.splice(this.sendQueueIdxToReceive, 1);
				this.sendQueueIdxToSend--; // need to adjust this for the splice
				if (entry.hooks) {
					entry.hooks.triggerSync('executing', entry);
					entry.hooks.triggerSync('executed', entry);
				}
			}
		} else {
			// Got an error on the request.  Splice it out of sendQueue, and call the error hook on the gcode line
			this.sendQueue.splice(this.sendQueueIdxToReceive, 1);
			this.sendQueueIdxToSend--; // need to adjust this for the splice
			if (entry.hooks) {
				entry.hooks.triggerSync('error', new XError(XError.INTERNAL_ERROR, 'Received error code from request to TinyG: ' + responseStatusCode));
			}
		}
		this._checkSendLoop();
	}

	// Checks the send queue to see if there's anything more that can be sent to the device.  Returns true if it can.
	_checkSendToDevice() {
		if (this._disableSending) return false; // don't send anything more until state has synchronized
		// Don't send more if we haven't received responses for more than a threshold number
		const maxUnackedRequests = this.config.maxUnackedRequests || 32;
		let numUnackedRequests = this.sendQueueIdxToSend - this.sendQueueIdxToReceive;
		if (numUnackedRequests >= maxUnackedRequests) return false;
		// We can send more if either 1) The serial receive buffer is filled less than 4 lines (recommended as per tinyg docs), or 2) The planner
		// queue is expected to have fewer than 24 entries in it
		// The number of slots in the receive buffer expected to be filled is equal to the number of responses we have not yet received for requests.
		let receiveBufferFilled = this.sendQueueIdxToSend - this.sendQueueIdxToReceive;
		const receiveBufferMaxFill = 4;
		if (receiveBufferFilled < receiveBufferMaxFill) return true;
		// Check how many planner buffers are free.  We start with the number free as of the last qr and deduct the worse case
		// scenario of buffers per line.  Send more lines if there's room for 1 more gcode line in the planner buffer.
		let effectiveFreePlannerBuffers = this.lastQrNumFree - 3; // subtract 3 because it looks like the tinyg won't parse a line unless there are at least 4 open planner buffers
		// for each unacked line sent since the last queue report, deduce the number of planner queue entries it's expected to use
		// TODO: track this count as a separate state variable to avoid doing this loop every time
		for (let i = this.sendQueueIdxToRecvAtLastQr; i < this.sendQueueIdxToSend && i < this.sendQueue.length; i++) {
			effectiveFreePlannerBuffers -= this.sendQueue[i].goesToPlanner;
		}
		// send another line if that line is expected to fit in planner queue
		let nextLinePlannerBuffers = (this.sendQueueIdxToSend < this.sendQueue.length) ? this.sendQueue[this.sendQueueIdxToSend].goesToPlanner : 4;
		return effectiveFreePlannerBuffers >= nextLinePlannerBuffers;
	}

	_checkSendLoop() {
		//this.debug('_checkSendLoop()');
		while ((this.sendImmediateCounter > 0 || this._checkSendToDevice()) && this.sendQueueIdxToSend < this.sendQueue.length) {
			//this.debug('_checkSendLoop() iteration');
			let entry = this.sendQueue[this.sendQueueIdxToSend];
			this._writeToSerial(entry.str + '\n');
			if (entry.hooks) {
				entry.hooks.triggerSync('sent', entry);
			}
			this.emit('sent', entry.str);
			this.sendQueueIdxToSend++;
			if (this.sendImmediateCounter > 0) this.sendImmediateCounter--;
		}
		//this.debug('_checkSendLoop() call _checkSynced');
		this._checkSynced();

		// If the next entry queued to receive a response doesn't actually expect a response, generate a "fake" response for it
		// Since _commsHandleAckResponseReceived() calls _checkSendLoop() after it's finished, this process continues for subsequent entries
		if (this.sendQueueIdxToReceive < this.sendQueueIdxToSend && !this.sendQueue[this.sendQueueIdxToReceive].responseExpected) {
			//this.debug('_checkSendLoop() call _commsHandleAckResponseReceived');
			this._commsHandleAckResponseReceived({});
		}
	}

	// Pushes a block of data onto the send queue.  The block is in the format of send queue entries.  This function cannot be used with
	// front-panel controls (ie, feed hold).  Lineid is added.
	_sendBlock(block, immediate = false) {
		//this.debug('_sendBlock() ' + block.str);
		if (!this.serial) throw new XError(XError.INTERNAL_ERROR, 'Cannot send, no serial connection');
		block.responseExpected = !!block.str.trim();

		if (immediate) {
			this._sendBlockImmediate(block);
			return;
		}
		block.lineid = this.lineIdCounter++;
		this.sendQueue.push(block);
		if (block.hooks) block.hooks.triggerSync('queued', block);
		this._checkSendLoop();
	}

	// Pushes a block onto the sendQueue such that it will be next to be sent, and force it to be sent immediately.
	_sendBlockImmediate(block) {
		//this.debug('_sendBlockImmediate() ' + block.str);
		if (!this.serial) throw new XError(XError.INTERNAL_ERROR, 'Cannot send, no serial connection');
		block.responseExpected = !!block.str.trim();

		// Need to insert the block immediately after the most recently sent block
		// Determine the line id based on its position
		let newLineId;
		let sendQueueIdxLastSent = this.sendQueueIdxToSend - 1;
		if (sendQueueIdxLastSent < 0) {
			// The most recently sent block has already been shifted off the sendQueue
			if (this.sendQueue.length) {
				// There are more entries queued to be sent; pick a lineid a bit below the the next block to be sent
				newLineId = this.sendQueue[0].lineid - 0.5;
			} else {
				// There are no more entries queued to be sent; increment the id counter as normal
				newLineId = this.lineIdCounter++;
			}
		} else {
			// We know the lineid of the last sent block
			let lineidLastSent = this.sendQueue[sendQueueIdxLastSent].lineid;
			if (this.sendQueue.length > this.sendQueueIdxToSend) {
				// There are more entries queued to be sent
				let lineidNextSent = this.sendQueue[this.sendQueueIdxToSend].lineid;
				newLineId = (lineidNextSent - lineidLastSent) / 2;
			} else {
				// There are not yet any more entries queued to be sent
				newLineId = this.lineIdCounter++;
			}
		}
		block.lineid = newLineId;

		// Insert the block where it needs to go in the send queue (as the next to send)
		this.sendQueue.splice(this.sendQueueIdxToSend, 0, block);
		if (block.hooks) block.hooks.triggerSync('queued', block);

		// Force sending this block
		this.sendImmediateCounter++;
		this._checkSendLoop();
	}

	// This function is called when a gcode line starts executing on the controller.  It is
	// responsible for updating any local state properties based on that gcode line.
	_updateStateFromGcode(gline) {
		// Shortcut case for simple common moves which don't need to be tracked here
		let isSimpleMove = true;
		for (let word of gline.words) {
			if (word[0] === 'G' && word[1] !== 0 && word[1] !== 1) { isSimpleMove = false;  break; }
			if (word[0] !== 'G' && word[0] !== 'X' && word[0] !== 'Y' && word[0] !== 'Z' && word[0] !== 'A' && word[0] !== 'B' && word[0] !== 'C' && word[0] !== 'F') {
				isSimpleMove = false;
				break;
			}
		}
		if (isSimpleMove) return;

		/* gcodes to watch for:
		 * G10 L2 - Changes coordinate system offsets
		 * G20/G21 - Select between inches and mm
		 * G28.1/G30.1 - Changes stored position
		 * G28.2 - Changes axis homed flags
		 * G28.3 - Also homes
		 * G54-G59 - Changes active coordinate system
		 * G90/G91 - Changes absolute/incremental
		 * G92* - Sets offset
		 * M2/M30 - In addition to ending program (handled by status reports), also changes others https://github.com/synthetos/TinyG/wiki/Gcode-Support#m2-m30-program-end
		 * M3/M4/M5 - Changes spindle state
		 * M7/M8/M9 - Changes coolant state
		*/

		let zeropoint = [];
		for (let i = 0; i < this.axisLabels.length; i++) zeropoint.push(0);

		if (gline.has('G10') && gline.has('L2') && gline.has('P')) {
			let csys = gline.get('P') - 1;
			if (!this.coordSysOffsets[csys]) this.coordSysOffsets[csys] = zeropoint;
			for (let axisNum = 0; axisNum < this.axisLabels.length; axisNum++) {
				let axis = this.axisLabels[axisNum].toUpperCase();
				if (gline.has(axis)) this.coordSysOffsets[csys][axisNum] = gline.get(axis);
			}
			this.emit('statusUpdate');
		}
		if (gline.has('G20') || gline.has('G21')) {
			this.units = gline.has('G20') ? 'in' : 'mm';
			this.emit('statusUpdate');
		}
		if (gline.has('G28.1') || gline.has('G30.1')) {
			let posnum = gline.has('G28.1') ? 0 : 1;
			this.storedPositions[posnum] = this.mpos.slice();
			this.emit('statusUpdate');
		}
		if (gline.has('G28.2') || gline.has('G28.3')) {
			for (let axisNum = 0; axisNum < this.axisLabels.length; axisNum++) {
				let axis = this.axisLabels[axisNum].toUpperCase();
				if (gline.has(axis)) this.homed[axisNum] = true;
			}
			this.emit('statusUpdate');
		}
		let csysCode = gline.get('G', 'G54');
		if (csysCode && csysCode >= 54 && csysCode <= 59 && Math.floor(csysCode) === csysCode) {
			this.activeCoordSys = csysCode - 54;
			this.emit('statusUpdate');
		}
		if (gline.has('G90') || gline.has('G91')) {
			this.incremental = gline.has('G91');
			this.emit('statusUpdate');
		}
		if (gline.has('G92')) {
			if (!this.offset) this.offset = zeropoint;
			for (let axisNum = 0; axisNum < this.axisLabels.length; axisNum++) {
				let axis = this.axisLabels[axisNum].toUpperCase();
				if (gline.has(axis)) this.offset[axisNum] = gline.get(axis);
			}
			this.offsetEnabled = true;
			this.emit('statusUpdate');
		}
		if (gline.has('G92.1')) {
			this.offset = zeropoint;
			this.offsetEnabled = false;
			this.emit('statusUpdate');
		}
		if (gline.has('G92.2')) {
			this.offsetEnabled = false;
			this.emit('statusUpdate');
		}
		if (gline.has('G92.3')) {
			this.offsetEnabled = true;
			this.emit('statusUpdate');
		}
		if (gline.has('G93') || gline.has('G94')) {
			this.inverseFeed = gline.has('G93');
			this.emit('statusUpdate');
		}
		if (gline.has('M2') || gline.has('M30')) {
			this.offset = zeropoint;
			this.offsetEnabled = false;
			this.activeCoordSys = 0;
			this.incremental = false;
			this.spindle = false;
			this.coolant = false;
			this.emit('statusUpdate');
			this.sendLine({ coor: null }, { immediate: true });
			this.sendLine({ unit: null }, { immediate: true });
		}
		if (gline.has('M3') || gline.has('M4') || gline.has('M5')) {
			this.spindle = !gline.has('M5');
			this.spindleDirection = gline.has('M4') ? -1 : 1;
			this.spindleSpeed = gline.get('S') || null;
			this.emit('statusUpdate');
		}
		if (gline.has('M7') || gline.has('M8') || gline.has('M9')) {
			if (gline.has('M7')) this.coolant = 1;
			else if (gline.has('M8')) this.coolant = 2;
			else this.coolant = false;
			this.emit('statusUpdate');
		}
	}

	sendGcode(gline, options = {}) {
		let hooks = options.hooks || (gline.triggerSync ? gline : new CrispHooks());
		hooks.hookSync('executing', () => this._updateStateFromGcode(gline));
		this._sendBlock({
			str: gline.toString(),
			hooks: hooks,
			gcode: gline,
			goesToPlanner: this._gcodeLineRequiresPlanner(gline)
		}, options.immediate);
	}

	sendLine(str, options = {}) {
		// Check for "immediate commands" like feed hold that don't go into the queue
		if (typeof str === 'string' && this._isImmediateCommand(str)) {
			//this._writeToSerial(str);
			this._handleSendImmediateCommand(str);
			return;
		}
		// If not a string, jsonify it
		if (typeof str !== 'string') str = AbbrJSON.stringify(str);
		// If it doesn't start with {, try to parse as gcode
		if (str.length && str[0] !== '{') {
			let gcode = null;
			try {
				gcode = new GcodeLine(str);
			} catch (err) {}
			if (gcode) {
				this.sendGcode(gcode, options);
				return;
			}
		}
		// If can't parse as gcode (or starts with {), send as plain string
		this._sendBlock({
			str: str,
			hooks: options.hooks,
			gcode: null,
			goesToPlanner: 0
		}, options.immediate);
	}

	// Returns # if we think the given gcode line will get pushed onto the TinyG planner queue
	_gcodeLineRequiresPlanner(gline) {
		let containsCoordinates = false;
		for (let label of this.axisLabels) {
			if (gline.has(label)) {
				containsCoordinates = true;
				break;
			}
		}
		// If it contains coordinates along with simple linear motion, assume it takes a single planner queue entry
		if (containsCoordinates && (gline.has('G0') || gline.has('G1'))) {
			return 1;
		}
		// If it contains coordinates without a non-motion G word, assume it goes to the planner queue
		if (
			containsCoordinates &&
			!gline.has('G10') &&
			!gline.has('G28.2') &&
			!gline.has('G28.3') &&
			!gline.has('G92')
		) {
			return 4;
		}
		// Check for other words that indicate it goes to the planner queue
		if (
			gline.has('G4') ||
			gline.has('G28') ||
			gline.has('G28.1') ||
			gline.has('G30') ||
			gline.has('G30.1') ||
			gline.has('M')
		) {
			return 4;
		}
		return 0;
	}

	_writeToSerial(str) {
		if (!this.serial) return;
		this.serial.write(str);
	}

	_isImmediateCommand(str) {
		str = str.trim();
		return str === '!' || str === '%' || str === '~' || str === '\x18';
	}

	// Temporarily disable sending anything to the machine for a period of time to wait for it to catch up or something
	_tempDisableSending(time = 3500) {
		this.debug('_tempDisableSending')
		let origDisableSending = this._disableSending;
		this._disableSending = true;
		setTimeout(() => {
			if (this._disableSending === true) this._disableSending = origDisableSending;
			this._checkSendLoop();
		}, time);
	}

	_handleSendImmediateCommand(str) {
		this._writeToSerial('\n' + str + '\n');
		str = str.trim();
		this.emit('sent', str);
		if (str === '!') {
			this.held = true;
		} else if (str === '~') {
			this.held = false;
		} else if (str === '%') {
			this._cancelRunningOps(new XError(XError.CANCELLED, 'Operation cancelled'));
			this.held = false;
			// I've found that things sent very shortly after a % can somehow get "lost".  So wait a while before sending anything more.
			this._tempDisableSending();
		} else if (str === '\x18') {
			this.debug('Handling Ctrl-X send -> _cancelRunningOps');
			this._cancelRunningOps(new XError(XError.CANCELLED, 'Machine reset'));
			this.ready = false; // will be set back to true once SYSTEM READY message received
			this._tempDisableSending();
		}
	}

	// Returns a promise that resolves when the line is received.  The promise resolves with the full response (ie, it's an object containing 'r').
	request(line) {
		return new Promise((resolve, reject) => {
			let hooks = new CrispHooks();
			let resolved = false;
			hooks.hookSync('ack', (entry, response) => {
				if (resolved) return;
				resolved = true;
				resolve(response);
			});
			hooks.hookSync('error', (err) => {
				if (resolved) return;
				resolved = true;
				reject(err);
			});
			this.send(line, { hooks: hooks });
		});
	}

	initConnection(retry = true) {
		this.debug('initConnection()');
		if (this._initializing) {
			this.debug('skipping, already initializing');
			return;
		}
		this._retryConnectFlag = retry;
		this.ready = false;
		this._initializing = true;
		this.emit('statusUpdate');

		if (this.serial || this.sendQueue.length) {
			this.close();
		}

		// Define an async function and call it so we can use async/await
		const doInit = async () => {

			// Set up options for serial connection.  (Set defaults, then apply configs on top.)
			let serialOptions = {
				autoOpen: true,
				baudRate: 115200,
				dataBits: 8,
				stopBits: 1,
				parity: 'none',
				rtscts: true,
				xany: false
			};
			for (let key in this.config) {
				if (key in serialOptions) {
					serialOptions[key] = this.config[key];
				}
			}
			let port = this.config.port || '/dev/ttyUSB0';

			// Try to open the serial port
			this.debug('Opening serial port');
			await new Promise((resolve, reject) => {
				this.serial = new SerialPort(port, serialOptions, (err) => {
					if (err) reject(new XError(XError.COMM_ERROR, 'Error opening serial port', err));
					else resolve();
				});
			});
			this.debug('Serial port opened');

			if (this.resetOnConnect) {
				this.debug('resetOnConnect flag set; sending reset');
				this.resetOnConnect = false;
				this.serial.write('\x18\n');
				await pasync.setTimeout(5000);
				this.debug('draining serial buffer');
				this.serial.read(); // drain the serial buffer
			}

			// This waiter is used for the pause during initialization later.  It's needed because
			// we need to be able to reject this and exit initialization if an error occurs while paused.
			let initializationPauseWaiter = pasync.waiter();

			// Initialize serial buffers and initial variables
			this.serialReceiveBuf = '';
			this.currentStatusReport = {};
			this.debug('initConnection calling _commsReset()');
			this._commsReset();

			// Set up serial port communications handlers
			const onSerialError = (err) => {
				this.debug('Serial error ' + err);
				err = new XError(XError.COMM_ERROR, 'Serial port communication error', err);
				if (!this._initializing) this.emit('error', err); // don't emit during initialization 'cause that's handled separately (by rejecting the waiters during close())
				this.close(err);
				this._retryConnect();
			};
			const onSerialClose = () => {
				this.debug('Serial close');
				// Note that this isn't called during intended closures via this.close(), since this.close() first removes all handlers
				let err = new XError(XError.COMM_ERROR, 'Serial port closed unexpectedly');
				if (!this._initializing) this.emit('error', err);
				this.close(err);
				this._retryConnect();
			};
			const onSerialData = (buf) => {
				// Remove any stray XONs, XOFFs, and NULs from the stream
				let newBuf = Buffer.alloc(buf.length);
				let newBufIdx = 0;
				for (let b of buf) {
					if (b != 0 && b != 17 && b != 19) {
						newBuf[newBufIdx] = b;
						newBufIdx++;
					}
				}
				buf = newBuf.slice(0, newBufIdx);

				let str = this.serialReceiveBuf + buf.toString('utf8');
				let strlines = str.split(/[\r\n]+/);
				if (!strlines[strlines.length-1].trim()) {
					// Received data ended in a newline, so don't need to buffer anything
					strlines.pop();
					this.serialReceiveBuf = '';
				} else {
					// Last line did not end in a newline, so add to buffer
					this.serialReceiveBuf = strlines.pop();
				}
				// Process each received line
				for (let line of strlines) {
					line = line.trim();
					if (line) {
						try {
							this._handleReceiveSerialDataLine(line);
						} catch (err) {
							if (!this._initializing) this.emit('error', err);
							this.close(err);
							this._retryConnect();
							break;
						}
					}
				}
			};
			this._serialListeners = {
				error: onSerialError,
				close: onSerialClose,
				data: onSerialData
			};
			for (let eventName in this._serialListeners) this.serial.on(eventName, this._serialListeners[eventName]);

			// This handles the case that the app might have been killed with a partially sent serial buffer.  Send a newline
			// to "flush" it, then wait a short period of time for any possible response to be received (and ignored).
			this._writeToSerial('\n');
			await pasync.setTimeout(500);
			setTimeout(() => {
				if (initializationPauseWaiter) {
					initializationPauseWaiter.resolve();
					initializationPauseWaiter = null;
				}
			}, 500);
			const pauseCancelRunningOpsHandler = (err) => {
				if (initializationPauseWaiter) {
					initializationPauseWaiter.reject(err);
					initializationPauseWaiter = null;
				}
			};
			this.on('cancelRunningOps', pauseCancelRunningOpsHandler);
			try {
				await initializationPauseWaiter.promise;
			} finally {
				this.removeListener('cancelRunningOps', pauseCancelRunningOpsHandler);
			}

			// Initialize all the machine state properties
			await this._initMachine();

			// Initialization succeeded
			this.ready = true;
			this._initializing = false;
			this.emit('ready');
			this.emit('statusUpdate');
			this.debug('initConnection() done');
		};

		doInit()
			.catch((err) => {
				this.debug('initConnection() error ' + err);
				this.emit('error', new XError(XError.COMM_ERROR, 'Error initializing connection', err));
				this.close(err);
				this._initializing = false;
				this._retryConnect();
			});
	}

	close(err) {
		this.debug('close() ' + err);
		if (err && !this.error) {
			this.error = true;
			this.errorData = err;
		}
		this.ready = false;
		this.debug('close() calling _cancelRunningOps()');
		this._cancelRunningOps(err || new XError(XError.CANCELLED, 'Operations cancelled due to close'));
		if (this.serial) {
			this.debug('close() removing listeners from serial');
			for (let key in this._serialListeners) {
				this.serial.removeListener(key, this._serialListeners[key]);
			}
			this._serialListeners = [];
			this.serial.on('error', () => {}); // swallow errors on this port that we're discarding
			this.debug('close() Trying to close serial');
			try { this.serial.close(); } catch (err2) {}
			this.debug('close() done closing serial');
			delete this.serial;
		}
		this.emit('statusUpdate');
		this.debug('close() complete');
	}

	_retryConnect() {
		this.debug('_retryConnect()');
		if (!this._retryConnectFlag) {
			this.debug('Skipping, retry connect disabled');
			return;
		}
		if (this._waitingToRetry) {
			this.debug('Skipping, already waiting to retry');
			return;
		}
		this._waitingToRetry = true;
		setTimeout(() => {
			this._waitingToRetry = false;
			this.debug('_retryConnect() calling initConnection()');
			this.initConnection(true);
		}, 5000);
	}

	_numInFlightRequests() {
		return this.sendQueue.length - this.sendQueueIdxToReceive;
	}

	// Check to see if the machine state is synchronized to local state, and the machine stopped.
	_checkSynced() {
		//this.debug('_checkSynced()');
		// The machine is considered to be synced when all of:
		// 1. The machine is stopped (the last status report indicated a machine status of such)
		// 2. There are no sent lines for which responses have not been received.
		// 3. There is nothing queued to be sent (or sending is paused)
		let wasSynced = this.synced;
		let nowSynced = (this.currentStatusReport.stat === 3 || this.currentStatusReport.stat === 4 || this.currentStatusReport.stat === 1) &&
			this.sendQueueIdxToReceive >= this.sendQueueIdxToSend &&
			(this.sendQueueIdxToSend >= this.sendQueue.length || this._disableSending);
		if (nowSynced !== wasSynced) {
			this.debug('Is now synced');
			if (nowSynced) {
				// Extra check to automatically call hooks on all gcode blocks in the planner when the machine stops
				this._commsSyncPlannerMirror();
			}
			this.synced = nowSynced;
			this.emit('statusUpdate');
		}
	}

	async waitSync() {
		// Fetch new status report to ensure up-to-date info (mostly in case a move was just requested and we haven't gotten an update from that yet)
		// If sends are disabled, instead just wait some time to make sure a response was received
		if (this._disableSending) {
			await pasync.setTimeout(250);
		} else {
			await this.request({ sr: null });
		}

		if (this.synced) return;

		// register a listener for status changes, and resolve when these conditions are met
		await new Promise((resolve, reject) => {
			if (this.error) return reject(new XError(XError.MACHINE_ERROR, 'Machine error code: ' + this.errorData));
			let removeListeners;
			this._waitingForSync = true;
			const statusHandler = () => {
				if (this.error) {
					this._waitingForSync = false;
					removeListeners();
					reject(new XError(XError.MACHINE_ERROR, 'Machine error code: ' + this.errorData));
				} else if (this.synced) {
					this._waitingForSync = false;
					removeListeners();
					resolve();
					this._checkSendLoop();
				}
			};
			const cancelRunningOpsHandler = (err) => {
				this._waitingForSync = false;
				removeListeners();
				reject(err);
			};
			removeListeners = () => {
				this.removeListener('statusUpdate', statusHandler);
				this.removeListener('cancelRunningOps', cancelRunningOpsHandler);
			};
			this.on('statusUpdate', statusHandler);
			this.on('cancelRunningOps', cancelRunningOpsHandler);
		});
	}

	_handleReceiveSerialDataLine(line) {
		//this.debug('receive line ' + line);
		this.emit('received', line);
		if (line[0] != '{') throw new XError(XError.PARSE_ERROR, 'Error parsing received serial line', { data: line });
		let data = AbbrJSON.parse(line);

		// Check if this is a SYSTEM READY response indicating a reset
		if ('r' in data && data.r.msg === 'SYSTEM READY') {
			this.debug('Got SYSTEM READY message');
			let err = new XError(XError.CANCELLED, 'Machine reset');
			this.close(err);
			if (!this._initializing) {
				this.debug('calling _retryConnect() after receive SYSTEM READY');
				this._retryConnect();
			}
			this.debug('Done handling SYSTEM READY in _handleReceiveSerialDataLine()');
			return;
		}

		// Check if this is an error report indicating an alarm state
		if ('er' in data) {
			if (!this._disableResponseErrorEvent) {
				this.error = true;
				this.errorData = data.er;
				this.ready = false;
				let err = new XError(XError.MACHINE_ERROR, data.er.msg || ('Code ' + data.er.st) || 'Machine error report', data.er);
				this._cancelRunningOps(err);
				if (!this._initializing) this.emit('error', err);
			}
			return;
		}

		let statusVars = {}; // updated status vars
		if ('sr' in data) {
			// Update the current status variables
			for (let key in data.sr) statusVars[key] = data.sr[key];
		}
		if ('qr' in data) {
			// Update queue report
			statusVars.qr = data.qr;
		}
		let queueReport = null;
		if ('qr' in data && 'qi' in data && 'qo' in data) {
			queueReport = data;
		}
		for (let key in this.currentStatusReport) {
			if (key in data) statusVars[key] = data[key];
			if ('r' in data && key in data['r']) statusVars[key] = data['r'][key];
		}
		let responseStatusCode = null;
		if ('r' in data) {
			if ('sr' in data.r) {
				// Update the current status variables
				for (let key in data.r.sr) statusVars[key] = data.r.sr[key];
			}
			if ('n' in data.r) {
				// Update gcode line number
				statusVars.n = data.r.n;
			}
			if ('qr' in data.r) {
				// Update queue number
				statusVars.qr = data.r.qr;
			}
			//if ('qr' in data.r && 'qi' in data.r && 'qo' in data.r) {
			//	queueReport = data.r;
			//}

			// Update status properties
			this._updateStatusReport(statusVars);
			// Check if successful or failure response
			responseStatusCode = data.f ? data.f[1] : 0;
			// Handle comms and sending more data when a response is received
			this._commsHandleAckResponseReceived(data);
			this._checkSynced();
		} else {
			this._updateStatusReport(statusVars);
		}
		this.emit('afterReceived', line);
		// If queue report information was received, update our communications state info accordingly
		if (queueReport) {
			this._commsHandleQueueReportReceived(queueReport);
		}
	}

	// Update stored state information with the given status report information
	_updateStatusReport(sr, emitEvent = true) {
		// Update this.currentStatusReport
		let statusUpdated = false;
		for (let key in sr) {
			if (this.currentStatusReport[key] !== sr[key]) {
				this.currentStatusReport[key] = sr[key];
				statusUpdated = true;
			}
		}
		// Keys we care about: mpo{x}, coor, g5{4}{x}, g92{x}, g{28,30}{x}, hom{x}, stat, unit, feed, dist, n
		// Check for axis-specific keys
		for (let axisNum = 0; axisNum < this.axisLabels.length; axisNum++) {
			let axis = this.axisLabels[axisNum];
			if (('mpo' + axis) in sr) this.mpos[axisNum] = sr['mpo' + axis];
			if (('g92' + axis) in sr) this.offset[axisNum] = sr['g92' + axis];
			if (('g28' + axis) in sr) this.storedPositions[0][axisNum] = sr['g28' + axis];
			if (('g30' + axis) in sr) this.storedPositions[1][axisNum] = sr['g30' + axis];
			if (('hom' + axis) in sr) this.homed[axisNum] = !!sr['hom' + axis];
			for (let csys = 0; csys < 6; csys++) {
				let csysName = 'g5' + (4 + csys);
				if (!this.coordSysOffsets[csys]) this.coordSysOffsets[csys] = [];
				if ((csysName + axis) in sr) this.coordSysOffsets[csys][axisNum] = sr[csysName + axis];
			}
		}
		// Non-axis keys
		if ('coor' in sr) {
			this.activeCoordSys = (sr.coor === 0) ? null : sr.coor - 1;
		}
		if ('unit' in sr) {
			this.units = sr.unit ? 'mm' : 'in';
		}
		if ('feed' in sr) {
			this.feed = sr.feed;
		}
		if ('dist' in sr) {
			this.incremental = !!sr.dist;
		}
		if ('n' in sr) {
			this.line = sr.n;
		}
		if ('qr' in sr) {
			this.plannerQueueFree = sr.qr;
		}
		if ('stat' in sr) {
			switch(sr.stat) {
				case 0: // initializing
					this.ready = false;
					this.held = false;
					this.moving = false;
					this.error = false;
					this.programRunning = false;
					break;
				case 1: // "reset"
					this.ready = true;
					this.held = false;
					this.moving = false;
					this.error = false;
					this.programRunning = false;
					break;
				case 2: // alarm
					this.ready = false;
					this.held = false;
					this.moving = false;
					this.error = true;
					if (!this.errorData) this.errorData = 'alarm';
					break;
				case 3: // stop
				case 8: // cycle
					this.ready = true;
					this.held = false;
					this.moving = false;
					this.error = false;
					this.programRunning = true;
					break;
				case 4: // end
					this.ready = true;
					this.held = false;
					this.moving = false;
					this.error = false;
					this.programRunning = false;
					break;
				case 5: // run
					this.ready = true;
					this.held = false;
					this.moving = true;
					this.error = false;
					this.programRunning = true;
					break;
				case 6: // hold
					this.ready = true;
					this.held = true;
					this.moving = false;
					this.error = false;
					break;
				case 7: // probe
					this.ready = true;
					this.held = false;
					this.moving = true;
					this.error = false;
					break;
				case 9: // homing
					this.ready = true;
					this.held = false;
					this.moving = true;
					this.error = false;
					break;
				default:
					throw new XError(XError.INTERNAL_ERROR, 'Unknown machine state: ' + sr.stat);
			}
		}
		if (statusUpdated && emitEvent) {
			this.emit('statusUpdate');
		}
		this._checkSynced();
	}

	// Fetch and update current status from machine, if vars is null, update all
	_fetchStatus(vars = null, emitEvent = true) {
		if (!vars) {
			vars = [ 'coor', 'stat', 'unit', 'feed', 'dist', 'n', 'qr' ];
			for (let axisNum = 0; axisNum < this.axisLabels.length; axisNum++) {
				let axis = this.axisLabels[axisNum];
				vars.push('mpo' + axis, 'g92' + axis, 'g28' + axis, 'g30' + axis, 'hom' + axis);
				for (let csys = 0; csys < 6; csys++) {
					vars.push('g5' + (4 + csys) + axis);
				}
			}
		}

		// Fetch each, constructing a status report
		let sr = {};
		let promises = [];
		const fetchVar = (name) => {
			let p = this.request({ [name]: null })
				.then((data) => {
					sr[name] = data.r[name];
				});
			promises.push(p);
		};
		for (let name of vars) {
			fetchVar(name);
		}
		return Promise.all(promises)
			.then(() => {
				this._updateStatusReport(sr, emitEvent);
			});
	}

	// Send serial commands to initialize machine and state after new serial connection
	async _initMachine() {
		this.debug('initMachine()');
		// Relaxed json syntax; this parser can handle it
		await this.request({ js: 0 });
		// Echo off (ideally this would be set at the same time as the above)
		await this.request({ ee: 0 });
		// Set json output verbosity
		await this.request({ jv: 4 });
		// Enable (filtered) automatic status reports
		await this.request({ sv: 1});
		// Enable triple queue reports
		await this.request({ qv: 2 });
		// Set automatic status report interval
		await this.request({ si: this.config.statusReportInterval || 250 });
		// Configure status report fields
		//await this.request({ sr: false }); // to work with future firmware versions where status report variables are configured incrementally
		let srVars = [ 'n', 'feed', 'stat' ];
		for (let axis of this.axisLabels) { srVars.push('mpo' + axis); }
		let srConfig = {};
		for (let name of srVars) { srConfig[name] = true; }
		await this.request({ sr: srConfig });
		// Fetch initial state
		await this._fetchStatus(null, false);
		// Set the planner queue size to the number of free entries (it's currently empty)
		this.plannerQueueSize = this.plannerQueueFree;
		// Fetch axis maximum velocities
		for (let axisNum = 0; axisNum < this.usedAxes.length; axisNum++) {
			if (this.usedAxes[axisNum]) {
				let axis = this.axisLabels[axisNum];
				let response = await this.request({ [axis + 'vm']: null });
				if (response.r) response = response.r;
				if (typeof response[axis + 'vm'] === 'number') {
					this.axisMaxFeeds[axisNum] = response[axis + 'vm'];
				}
			}
		}
		this.debug('initMachine() finished');
	}

	sendStream(stream) {
		let waiter = pasync.waiter();

		// Bounds within which to stop and start reading from the stream.  These correspond to the number of queued lines
		// not yet sent to the controller.
		let sendQueueHighWater = this.config.streamSendQueueHighWaterMark || 20;
		let sendQueueLowWater = this.config.streamSendQueueLowWaterMark || Math.min(10, Math.floor(sendQueueHighWater / 5));
		let streamPaused = false;
		let canceled = false;

		const numUnsentLines = () => {
			return this.sendQueue.length - this.sendQueueIdxToSend;
		};

		const sentListener = () => {
			// Check if paused stream can be resumed
			if (numUnsentLines() <= sendQueueLowWater) {
				stream.resume();
				streamPaused = false;
			}
		};

		const cancelHandler = (err) => {
			this.removeListener('sent', sentListener);
			this.removeListener('cancelRunningOps', cancelHandler);
			canceled = true;
			waiter.reject(err);
			stream.emit('error', err);
		};

		stream.on(stream._isZStream ? 'chainerror' : 'error', (err) => {
			if (canceled) return;
			this.removeListener('sent', sentListener);
			this.removeListener('cancelRunningOps', cancelHandler);
			waiter.reject(err);
			canceled = true;
		});

		this.on('sent', sentListener);

		stream.on('data', (chunk) => {
			if (canceled) return;
			if (!chunk) return;
			this.send(chunk);
			// if send queue is too full, pause the stream
			if (numUnsentLines() >= sendQueueHighWater) {
				stream.pause();
				streamPaused = true;
			}
		});

		stream.on('end', () => {
			if (canceled) return;
			this.removeListener('sent', sentListener);
			this.removeListener('cancelRunningOps', cancelHandler);
			this.waitSync()
				.then(() => waiter.resolve(), (err) => waiter.reject(err));
		});

		this.on('cancelRunningOps', cancelHandler);

		return waiter.promise;
	}

	_cancelRunningOps(err) {
		this.debug('_cancelRunningOps()');
		this._commsReset(err);
		this.debug('_cancelRunningOps() calling _checkSynced()');
		this._checkSynced();
		this.debug('_cancelRunningOps() emitting cancelRunningOps');
		this.emit('cancelRunningOps', err);
		this.debug('_cancelRunningOps() done');
	}

	hold() {
		this.sendLine('!');
	}

	resume() {
		this.sendLine('~');
	}

	cancel() {
		if (!this.held) this.hold();
		this.sendLine('%'); // wipe planner buffer and serial buffer; sendLine() also intercepts this to clean other stuff up
		this.sendLine('M5'); // spindle off
		this.sendLine('M9'); // coolant off
	}

	reset() {
		if (this.serial) {
			this.debug('reset() called with serial; sending Ctrl-X');
			this.sendLine('\x18');
		} else {
			this.debug('reset() called without serial; setting resetOnConnect flag');
			this.resetOnConnect = true;
		}
	}

	async home(axes = null) {
		if (!axes) axes = this.homableAxes;
		let gcode = 'G28.2';
		for (let axisNum = 0; axisNum < axes.length; axisNum++) {
			if (axes[axisNum]) {
				gcode += ' ' + this.axisLabels[axisNum].toUpperCase() + '0';
			}
		}
		await this.request(gcode);
		await this.waitSync();
	}

	async move(pos, feed = null) {
		let gcode = feed ? 'G1' : 'G0';
		for (let axisNum = 0; axisNum < pos.length; axisNum++) {
			if (typeof pos[axisNum] === 'number') {
				gcode += ' ' + this.axisLabels[axisNum].toUpperCase() + pos[axisNum];
			}
		}
		await this.request(gcode);
		await this.waitSync();
	}

	realTimeMove(axisNum, inc) {
		// Make sure there aren't too many requests in the queue
		if (this._numInFlightRequests() > (this.config.realTimeMovesMaxQueued || 8)) return false;
		// Rate-limit real time move requests according to feed rate
		let rtmTargetFeed = (this.axisMaxFeeds[axisNum] || 500) * 0.9; // target about 90% of max feed rate
		let counterDecrement = (new Date().getTime() - this.realTimeMovesTimeStart[axisNum]) / 1000 * rtmTargetFeed / 60;
		this.realTimeMovesCounter[axisNum] -= counterDecrement;
		if (this.realTimeMovesCounter[axisNum] < 0) {
			this.realTimeMovesCounter[axisNum] = 0;
		}
		this.realTimeMovesTimeStart[axisNum] = new Date().getTime();
		let maxOvershoot = (this.config.realTimeMovesMaxOvershootFactor || 2) * Math.abs(inc);
		if (this.realTimeMovesCounter[axisNum] > maxOvershoot) return false;
		this.realTimeMovesCounter[axisNum] += Math.abs(inc);
		// Send the move
		this.send('G91');
		let gcode = 'G0 ' + this.axisLabels[axisNum].toUpperCase() + inc;
		this.send(gcode);
		this.send('G90');
	}

	_sendImmediate(line, waiter = null) {
		let hooks = new CrispHooks();
		this.send(line, { immediate: true, hooks: hooks });
		let resolved = false;
		if (waiter) {
			hooks.hookSync('ack', (_entry, r) => {
				if (resolved) return;
				resolved = true;
				waiter.resolve(r);
			});
			hooks.hookSync('error', (err) => {
				if (resolved) return;
				resolved = true;
				waiter.reject(err);
			});
		}
	}

	async probe(pos, feed = null) {
		/*
		 * My TinyG {fb:440.20, fv:0.97} has probing behavior that does not match the documented
		 * behavior (12/1/19) in several ways.  This code should work with both my TinyG, and the behavior
		 * as documented.  The oddities are:
		 * - The documentation implies that automatic probe reports are generated outside of a
		 *   response wrapper.  Ie, automatic probe reports should come back as {"prb":{...}}.
		 *   Instead, they are wrapped in a response wrapper as {"r":{"prb":{...}}.  This is
		 *   inconsistent with the communications protocol documentation which states that exactly
		 *   one {"r":{...}} response is returned for each sent request, and causes their provided
		 *   communications algorithm to become desynced (since the probe report with response
		 *   wrapper is generated without an accompanying request).  This is handled by 1) Ignoring
		 *   any responses that occur when there are no in-flight requests, 2) Ensure there are no
		 *   other in-flight requests before probing, 3) Disabling data sends while probing is in
		 *   progress, 4) Ignoring any automatic probe reports and instead manually requesting them.
		 *   5) Waiting a small period of time after probing completes to allow this extra response
		 *   to be received and ignored, before sending any more data.
		 * - The documentation states that automatic probe reports can be disabled with {prbr:f}.
		 *   This has no effect for me, and automatic probe reports continue to be generated.  Hence
		 *   the above workarounds.
		 * - The documentation states that G38.3 should be used for probing without alarming on no
		 *   contact.  G38.3 does nothing for me.  Instead, G38.2 is used here.
		 * - The documentation states that G38.2 will put the machine in soft alarm state if the
		 *   probe is not tripped.  This does not occur for me.  To handle systems where it may,
		 *   {clear:null} is sent unconditionally after probing completes.  Additionally, if waitForSync
		 *   rejects, the rejection is ignored.
		 * - On my TinyG, G38.2 seems to do nothing in some cases where more than one axis is provided.
		 *   So this function ensures that at most one axis differs from the current position, and only
		 *   sends that.
		 * - The LinuxCNC documentation (referenced by the TinyG documentation) states that the
		 *   coordinates of the parameters should be in the current coordinate system (and, presumably,
		 *   should match the coordinates of the probe reports).  With my TinyG, both the parameters
		 *   and coordinates are in machine coordinates.  Because this probably won't be reliably
		 *   consistent, a test is performed for the first probe.  A G38.2 probe is sent for the current
		 *   position (either in machine coords or local coords, whichever will cause the probe to
		 *   move in the right direction if we're wrong).  If any motion is detected, the move is immediately
		 *   cancelled, and we know it's the other coordinate system.  If there's no motion, we
		 *   know it's that coordinate system.  This test can be overridden using config.probeUsesMachineCoords.
		 * - Requests for status reports during probing don't seem to work (they seem to be delayed until
		 *   after probing is complete).  So we can't rely on this to know when probe movement has started.
		 *   Instead, just wait for a delay after sending the probe before checking for movement status.
		 *   This is handled by waitSync().
		 * - On my TinyG, its active coordinate system is randomly reset after probing.  Handle this by saving
		 *   the active coordinate system prior to probing, and manually restoring it after.
		 * - I've occasionally seen cases where the 'e' return value in the probe report does not reliably
		 *   report when the probe it tripped (it's set to 0 even if the probe was in fact tripped).  To
		 *   compensate for this, also consider the probe tripped if it terminated before reaching its
		 *   endpoint.
		 */

		let waiter;
		if (feed === null || feed === undefined) feed = 25;

		// Disable other requests while probing is running
		this._disableSending = true;
		// Disable error events, since we may need to handle soft alarms
		this._disableResponseErrorEvent = true;

		try {
			// Wait for motion to stop so position information is synchronized
			await this.waitSync();

			// Ensure a single axis will move.
			let selectedAxisNum = null;
			let curOffsets = this.getCoordOffsets();
			let curPos = this.getPos().slice();
			for (let axisNum = 0; axisNum < pos.length; axisNum++) {
				if (typeof pos[axisNum] === 'number' && pos[axisNum] !== curPos[axisNum]) {
					if (selectedAxisNum !== null) {
						throw new XError(XError.INVALID_ARGUMENT, 'Can only probe on a single axis at once');
					}
					selectedAxisNum = axisNum;
				}
			}
			if (selectedAxisNum === null) throw new XError(XError.INVALID_ARGUMENT, 'Cannot probe to same location');

			// Store the currently active coordinate system to work around tinyg bug
			let activeCoordSys = this.activeCoordSys;

			// Test if the current version of TinyG uses machine coordinates for probing or local coordinates
			// Note that if offsets are zero, it doesn't matter, and don't bother testing
			// If, at some point, the build versions of TinyG that have this oddity are known and published, those will be a much better test than this hack
			if (this.config.probeUsesMachineCoords === undefined && curOffsets[selectedAxisNum] !== 0) {
				// See above block comment for explanation of this process.
				// determine if test probe is to same coordinates in offset coords or machine coords
				let probeTestToSameMachineCoords = curOffsets[selectedAxisNum] > 0;
				if (pos[selectedAxisNum] - curPos[selectedAxisNum] < 0) probeTestToSameMachineCoords = !probeTestToSameMachineCoords;
				let probeTestCoord = probeTestToSameMachineCoords ? this.mpos[selectedAxisNum] : curPos[selectedAxisNum];
				let startingMCoord = this.mpos[selectedAxisNum];
				// run probe to selected point; use _sendImmediate since normal sends are disabled
				const probeTestFeed = 1;
				let testProbeGcode = 'G38.2 ' + this.axisLabels[selectedAxisNum].toUpperCase() + probeTestCoord + ' F' + probeTestFeed;
				waiter = pasync.waiter();
				this._sendImmediate(testProbeGcode, waiter);
				// Probing to the same point is not currently a response error on my system, but in case it becomes one, wrap this in a try/catch
				try { await waiter.promise; } catch (err) {}
				// On my system, probing to the same point generates an extra response (after the normal response) that looks like this: {"r":{"msg":"Probing error - invalid probe destination"},"f":[1,250,0,8644]}
				// To allow time for this response to be received, as well as for movement to start (at this slow feed rate), wait a short period of time
				await pasync.setTimeout(750);
				// Execute a feed hold (to stop movement if it's occurring), a wipe (to prevent the movement from resuming), and a clear (in case it soft alarmed)
				this._sendImmediate('!');
				this._sendImmediate('%');
				this._sendImmediate({clear:null});
				// Reject the waiter if it hasn't resolved, since we cleared it out with the wipe
				waiter.reject('');
				// Request an updated machine position for the axis we're testing
				waiter = pasync.waiter();
				this._sendImmediate({ ['mpo' + this.axisLabels[selectedAxisNum].toLowerCase()]: null }, waiter);
				let mpoResult = await waiter.promise;
				// Depending on whether or not the probe moved during that time, we now know if this tinyg version expects machine or offset coordinates
				let nowMCoord = mpoResult.r['mpo' + this.axisLabels[selectedAxisNum].toLowerCase()];
				if (typeof nowMCoord !== 'number') throw new XError(XError.INTERNAL_ERROR, 'Unexpected response from TinyG');
				let probeMoved = nowMCoord !== startingMCoord;
				if (probeMoved) {
					this.config.probeUsesMachineCoords = !probeTestToSameMachineCoords;
					// Move back to the starting position before the test
					waiter = pasync.waiter();
					this._sendImmediate('G53 G0 ' + this.axisLabels[selectedAxisNum].toUpperCase() + startingMCoord, waiter);
					await waiter.promise;
				} else {
					this.config.probeUsesMachineCoords = probeTestToSameMachineCoords;
				}
			}
			let useMachineCoords = curOffsets[selectedAxisNum] === 0 || this.config.probeUsesMachineCoords;

			// Run the probe in the coordinate system chosen
			let probeTo = useMachineCoords ? (pos[selectedAxisNum] + curOffsets[selectedAxisNum]) : pos[selectedAxisNum];
			let probeDirection = (pos[selectedAxisNum] > curPos[selectedAxisNum]) ? 1 : -1;
			let probeGcode = 'G38.2 ' + this.axisLabels[selectedAxisNum].toUpperCase() + probeTo + ' F' + feed;
			waiter = pasync.waiter();
			this._sendImmediate(probeGcode, waiter);
			await waiter.promise; // wait for first response to probe to be received
			await this.waitSync(); // wait for probe movement to stop
			await pasync.setTimeout(250); // wait additional time to ensure "extra" response is received and ignored
			this._sendImmediate({clear:null}); // clear possible soft alarm state

			// Fetch probe report
			waiter = pasync.waiter();
			this._sendImmediate({ prb: null }, waiter);
			let probeResult = await waiter.promise;
			let probeReport = probeResult.r.prb;
			let probeTripped = !!probeReport.e;
			let probePos = probeReport[this.axisLabels[selectedAxisNum]];

			// Workaround for e value sometimes being incorrect
			if (
				(probeDirection > 0 && probePos < probeTo) ||
				(probeDirection < 0 && probePos > probeTo)
			) {
				probeTripped = true;
			}

			// Restore active coordinate system (to work around bug)
			if (typeof activeCoordSys === 'number' && activeCoordSys >= 0) {
				this._sendImmediate('G' + (54 + activeCoordSys));
				this.activeCoordSys = activeCoordSys;
			}

			// Handle probe results
			if (!probeTripped) {
				throw new XError(XError.PROBE_NOT_TRIPPED, 'Probe was not tripped during probing');
			}
			if (useMachineCoords) {
				// Convert probe report position from machine coords back to offset coords
				probePos = probePos - curOffsets[selectedAxisNum];
			}
			curPos[selectedAxisNum] = probePos;
			return curPos;

		} finally {
			this._disableSending = false;
			this._disableResponseErrorEvent = false;
			this._checkSendLoop();
		}
	}

	getStatus() {
		let o = super.getStatus();
		o.comms = {
			sendQueueLength: this.sendQueue.length,
			plannerMirrorLength: this.plannerMirror.length,
			sendQueueIdxToSend: this.sendQueueIdxToSend,
			sendQueueIdxToReceive: this.sendQueueIdxToReceive,
			sendQueueIdxToRecvAtLastQr: this.sendQueueIdxToRecvAtLastQr,
			lastQrNumFree: this.lastQrNumFree,
			checkSend: this._checkSendToDevice()
		};
		return o;
	}

};

module.exports = TinyGController;



