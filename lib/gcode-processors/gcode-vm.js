const GcodeProcessor = require('../gcode-processor');
const XError = require('xerror');
const objtools = require('objtools');



/**
 * This gcode processor is a virtual machine that tracks the state of a gcode job as it executes, and annotates all gcode lines
 * with the state of the virtual machine before and after the gcode line executes.  This is necessary to find the actual positions
 * of the machine during a job.
 *
 * This virtual machine is primarily intended for analysis of jobs that are mostly machine movement, but also includes support
 * for some command codes.  Note that it is note a validator, and may not represent actual machine behavior with invalid gcode.
 *
 * Gcode lines passing through the stream are annotated with the following properties:
 * - before - The virtual machine state prior to the line being executed.
 * - after - The virtual machine state after the line is executed.
 * - isMotion - A boolean flag indicating whether the gcode line is a movement command.
 * Additionally, the virtual machine state object is available on the GcodeVM under the `vmState` property.
 *
 * Virtual machine state contains a number of properties.  The most useful are probably the following:
 * - axisLabels - An array of (lowercase) letters for each of the axes.  The indexes into this array correspond to the indexes
 *   into the various position values.
 * - pos - Current position in active coordinate system.  This is an array of numbers, with indexes corresponding to axes.
 * - spindle - Whether the spindle is on or off.
 * - line - Last gcode line number processed.
 * - totalTime - Estimated total time in second for the job up to the current point, in seconds.
 * - bounds - The bounding box for all coordinates present in moves.  [ LowPosition, HighPosition ]
 * - coord(pos, axis) - A utility function to fetch the coordinate of the given position at the given axis.  The axis can
 *   be specified either by number or letter.
 *
 * @class GcodeVM
 * @constructor
 * @param {Object} [options]
 *   @param {Controller} controller - The machine controller class instance for the gcode to run on.  Used to fetch initial state.
 *   @param {OpManager} opmanager - Operations manager.  Can also be provided to get some initial state.
 *   @param {String[]} axisLabels - Override default axis labels.  Defaults come from the controller, or are [ 'x', 'y', 'z' ].
 *   @param {Number} maxFeed - Maximum feed rate, used to calculate time for G0 moves.
 *   @param {Number} minMoveTime - Minimum time to count for a move.  Can be set to a low value to compensate for delays if lots
 *     of small moves aren't filling the controller's buffer.
 */
class GcodeVM extends GcodeProcessor {

	constructor(options = {}) {
		super(options, 'GcodeVM', false);
	}

	// Gets or sets an axis value in a coordinate array.
	// If value is null, it returns the current value.  If value is numeric, it sets it.
	coord(coords, axis, value = null) {
		let axisNum = (typeof axis === 'number') ? axis : this.vmState.axisLabels.indexOf(axis.toLowerCase());
		if (axisNum === -1) throw new XError(XError.INVALID_ARGUMENT, 'Invalid axis ' + axis);
		if (axisNum < 0 || axisNum >= this.vmState.axisLabels.length) throw new XError(XError.INVALID_ARGUMENT, 'Axis out of bounds ' + axisNum);
		if (typeof value === 'number') {
			while (axisNum >= coords.length) coords.push(0);
			coords[axisNum] = value;
		} else {
			return coords[axisNum] || 0;
		}
	}

	zerocoord(val = 0) {
		let coords = [];
		for (let i = 0; i < this.vmState.axisLabels.length; i++) coords.push(val);
		return coords;
	}

	initProcessor() {
		// note: if opmanager is passed in as an option, and it has a controller attached, get initial values from that
		let controller = this.processorOptions.controller || (this.processorOptions.opmanager && this.processorOptions.opmanager.controller) || {};
		let vmState = {};
		this.vmState = vmState;
		vmState.axisLabels = this.processorOptions.axisLabels || controller.axisLabels || [ 'x', 'y', 'z' ];
		vmState.coord = this.coord.bind(this);
		vmState.mpos = controller.mpos || this.zerocoord();
		vmState.pos = (controller.getPos && controller.getPos()) || this.zerocoord();
		vmState.activeCoordSys = (typeof controller.activeCoordSys === 'number') ? controller.activeCoordSys : null;
		vmState.coordSysOffsets = controller.coordSysOffsets || [ this.zerocoord() ];
		vmState.offset = controller.offset || this.zerocoord();
		vmState.offsetEnabled = controller.offsetEnabled || false;
		vmState.storedPositions = controller.storedPositions || [ this.zerocoord(), this.zerocoord() ];
		vmState.units = controller.units || 'mm';
		vmState.feed = controller.feed || this.processorOptions.maxFeed || 1000;
		vmState.incremental = controller.incremental || false;
		vmState.coolant = controller.coolant || false;
		vmState.spindle = controller.spindle || false;
		vmState.line = controller.line || 0;
		vmState.spindleDirection = controller.spindleDirection || 1;
		vmState.inverseFeed = controller.inverseFeed || false;
		vmState.totalTime = 0; // seconds
		vmState.motionMode = controller.motionMode || null;
		vmState.arcPlane = controller.arcPlane || 0;
		vmState.bounds = [ this.zerocoord(null), this.zerocoord(null) ]; // min and max points
		vmState.mbounds = [ this.zerocoord(null), this.zerocoord(null) ]; // bounds for machine coordinates
	}

	_convertCoordSys(pos, fromCoordSys, toCoordSys, fromOffset = null, toOffset = null) {
		let vmState = this.vmState;
		let retPos = [];
		for (let axisNum = 0; axisNum < pos.length; axisNum++) {
			let fromTotalOffset = 0;
			let toTotalOffset = 0;
			if (typeof fromCoordSys === 'number') {
				fromTotalOffset += (vmState.coordSysOffsets[fromCoordSys] || [])[axisNum] || 0;
			}
			if (typeof toCoordSys === 'number') {
				toTotalOffset += (vmState.coordSysOffsets[toCoordSys] || [])[axisNum] || 0;
			}
			if (fromOffset) {
				fromTotalOffset += fromOffset[axisNum] || 0;
			}
			if (toOffset) {
				toTotalOffset += toOffset[axisNum] || 0;
			}
			retPos.push((pos[axisNum] || 0) + fromTotalOffset - toTotalOffset);
		}
		return retPos;
	}

	_updateMPosFromPos() {
		this.vmState.mpos = this._convertCoordSys(this.vmState.pos, this.vmState.activeCoordSys, null, this.vmState.offsetEnabled && this.vmState.offset, null);
	}

	_updatePosFromMPos() {
		this.vmState.pos = this._convertCoordSys(this.vmState.mpos, null, this.vmState.activeCoordSys, null, this.vmState.offsetEnabled && this.vmState.offset);
	}

	_updateBounds(bounds, pos, axisFlags) {
		for (let axisNum = 0; axisNum < pos.length; axisNum++) {
			let v = pos[axisNum];
			if (typeof v !== 'number' || (axisFlags && !axisFlags[axisNum])) continue;
			if (bounds[0][axisNum] === null || v < bounds[0][axisNum]) {
				bounds[0][axisNum] = v;
			}
			if (bounds[1][axisNum] === null || v > bounds[1][axisNum]) {
				bounds[1][axisNum] = v;
			}
		}
	}

	_processMove(to, axisFlags, feed = null, travel = null, incremental = false) {
		if (incremental) {
			// Update pos if incremental coordinates
			to = objtools.deepCopy(to);
			for (let axisNum = 0; axisNum < this.vmState.pos.length; axisNum++) {
				to[axisNum] = (to[axisNum] || 0) + this.vmState.pos[axisNum];
			}
		}
		// Calculate distance travelled if not provided
		if (travel === null) {
			let travelSq = 0;
			for (let axisNum = 0; axisNum < this.vmState.pos.length; axisNum++) {
				if (to[axisNum] === null || to[axisNum] === undefined) to[axisNum] = this.vmState.pos[axisNum];
				travelSq += Math.pow((to[axisNum] || 0) - (this.vmState.pos[axisNum] || 0), 2);
				this.vmState.pos[axisNum] = to[axisNum];
			}
			travel = Math.sqrt(travelSq);
		}
		// Get feed if not provided
		if (!feed) feed = this.processorOptions.maxFeed || 1000;
		let moveTime;
		if (this.vmState.inverseFeed) {
			// Handle time calc if inverse feed
			let minTime = travel / (this.processorOptions.maxFeed || 1000);
			if (!feed) feed = minTime;
			if (feed < minTime) feed = minTime;
			moveTime = feed * 60;
		} else {
			// Handle time calc if normal feed
			if (!feed) feed = this.processorOptions.maxFeed || 1000;
			moveTime = (travel / feed) * 60;
		}
		if (this.processorOptions.minMoveTime && moveTime < this.processorOptions.minMoveTime) {
			moveTime = this.processorOptions.minMoveTime;
		}
		this.vmState.totalTime += moveTime;
		// Update local coordinates
		for (let axisNum = 0; axisNum < to.length; axisNum++) {
			this.vmState.pos[axisNum] = to[axisNum];
		}
		// Update machine position
		this._updateMPosFromPos();
		// Update bounds
		this._updateBounds(this.vmState.bounds, this.vmState.pos, axisFlags);
		this._updateBounds(this.vmState.mbounds, this.vmState.mpos, axisFlags);
	}

	_setCoordSys(num) {
		this.vmState.pos = this._convertCoordSys(this.vmState.pos, this.vmState.activeCoordSys, num, null, null); // note, offsets from vmState.offset are cancelled out so don't need to be passed
		this.vmState.activeCoordSys = num;
	}

	processGcode(gline) {
		// This is NOT a gcode validator.  Input gcode is expected to be valid and well-formed.
		//
		let vmState = this.vmState;
		let origVMState = objtools.deepCopy(vmState);

		// Determine if this line represents motion
		let motionCode = null; // The G code on this line in the motion modal group (indicating some kind of machine motion)
		let hasCoords = []; // A list of axis word letters present (eg. [ 'X', 'Z' ]) 
		let coordPos = objtools.deepCopy(vmState.pos); // Position indicated by coordinates present, filling in missing ones with current pos
		let coordPosSparse = this.zerocoord(null); // Position indicated by coordinates present, with missing axes filled in with nulls
		let coordFlags = this.zerocoord(false); // True in positions where coordinates are present

		// Determine which axis words are present and convert to coordinate arrays
		for (let axisNum = 0; axisNum < vmState.axisLabels.length; axisNum++) {
			let axis = vmState.axisLabels[axisNum].toUpperCase();
			let val = gline.get(axis);
			if (typeof val === 'number') {
				hasCoords.push(axis);
				coordPos[axisNum] = val;
				coordPosSparse[axisNum] = val;
				coordFlags[axisNum] = true;
			}
			if (gline.has(axis)) hasCoords.push(axis);
		}

		// Check if a motion gcode is indicated (either by presence of a motion gcode word, or presence of coordinates without any other gcode)
		if (!gline.has('G') && hasCoords.length) {
			motionCode = vmState.motionMode;
		} else {
			motionCode = gline.get('G', 'G0');
			if (typeof motionCode === 'number') {
				motionCode = 'G' + motionCode;
				vmState.motionMode = motionCode;
			}
		}

		// Check for other codes that set modals
		let wordF = gline.get('F');
		if (typeof wordF === 'number') vmState.feed = wordF;
		if (gline.has('G17')) vmState.arcPlane = 0;
		if (gline.has('G18')) vmState.arcPlane = 1;
		if (gline.has('G19')) vmState.arcPlane = 2;
		if (gline.has('G20')) vmState.units = 'in';
		if (gline.has('G21')) vmState.units = 'mm';
		for (let i = 0; i < 6; i++) {
			if (gline.has('G' + (54 + i))) this._setCoordSys(i);
		}
		if (gline.has('G80')) vmState.motionMode = null;
		if (gline.has('G90')) vmState.incremental = false;
		if (gline.has('G91')) vmState.incremental = true;
		if (gline.has('G93')) vmState.inverseFeed = true;
		if (gline.has('G94')) vmState.inverseFeed = false;
		if (gline.has('M2') || gline.has('M30')) {
			vmState.offset = this.zerocoord();
			vmState.offsetEnabled = false;
			vmState.activeCoordSys = 0;
			vmState.arcPlane = 0;
			vmState.incremental = false;
			vmState.inverseFeed = false;
			vmState.spindle = false;
			vmState.motionMode = null;
			vmState.coolant = false;
			vmState.units = 'mm';
		}
		let wordS = gline.get('S');
		if (typeof wordS === 'number') vmState.spindleSpeed = wordS;
		if (gline.has('M3')) {
			vmState.spindleDirection = 1;
			vmState.spindle = true;
		}
		if (gline.has('M4')) {
			vmState.spindleDirection = -1;
			vmState.spindle = true;
		}
		if (gline.has('M5')) vmState.spindle = false;
		if (gline.has('M7')) {
			if (vmState.coolant === 2) vmState.coolant = 3;
			else vmState.coolant = 1;
		}
		if (gline.has('M8')) {
			if (vmState.coolant === 1) vmState.coolant = 3;
			else vmState.coolant = 2;
		}
		if (gline.has('M9')) vmState.coolant = false;
		
		
		// Check if temporary G53 coordinates are in effect
		let tempCoordSys = false;
		if (gline.has('G53')) {
			tempCoordSys = true;
			this._setCoordSys(null);
		}

		// Handle motion
		let doMotion = motionCode;
		let isMotion = false;
		if (gline.has('G28')) doMotion = 'G28';
		if (gline.has('G30')) doMotion = 'G30';
		if (doMotion === 'G0' && hasCoords.length) {
			this._processMove(coordPos, coordFlags, null, null, vmState.incremental);
			isMotion = true;
		} else if (doMotion === 'G1' && hasCoords.length) {
			this._processMove(coordPos, coordFlags, vmState.feed, null, vmState.incremental);
			isMotion = true;
		} else if ((doMotion === 'G2' || doMotion === 'G3') && hasCoords.length) {
			// TODO: calculate travel distance properly here
			this._processMove(coordPos, coordFlags, vmState.feed, null, vmState.incremental);
			isMotion = true;
		} else if (doMotion === 'G28' || doMotion === 'G30') {
			if (hasCoords.length) {
				this._processMove(coordPos, coordFlags, vmState.feed, null, vmState.incremental);
			}
			let storedPos = vmState.storedPositions[(doMotion === 'G28') ? 0 : 1];
			storedPos = this._convertCoordSys(storedPos, null, vmState.activeCoordSys, null, vmState.offsetEnabled && vmState.offset);
			this._processMove(storedPos, null, vmState.feed, null, false);
			isMotion = true;
		} else if (doMotion) {
			throw new XError(XError.UNSUPPORTED_OPERATION, 'Unsupported motion gcode: ' + doMotion);
		}

		// Handle G10 L2
		if (gline.has('G10') && gline.has('L2') && gline.has('P') && hasCoords.length) {
			this._updateMPosFromPos();
			let newOffset = coordPosSparse.map((v) => (v || 0));
			let coordSys = gline.get('P') - 1;
			vmState.coordSysOffsets[coordSys] = newOffset;
			this._updatePosFromMPos();
		}

		// Handle G28.1
		if (gline.has('G28.1')) {
			vmState.storedPositions[0] = objtools.deepCopy(vmState.mpos);
		}
		if (gline.has('G30.1')) {
			vmState.storedPositions[1] = objtools.deepCopy(vmState.mpos);
		}

		// Handle homing (can't really be handled exactly correctly without knowing actual machine position)
		if (gline.has('G28.2') || gline.has('G28.3')) {
			for (let axisNum = 0; axisNum < coordPosSparse.length; axisNum++) {
				if (coordPosSparse[axisNUm] !== null) vmState.mpos[axisNum] = 0;
			}
		}

		// Handle G92
		if (gline.has('G92')) {
			this._updateMPosFromPos();
			vmState.offset = coordPosSparse.map((v) => (v || 0));
			vmState.offsetEnabled = true;
			this._updatePosFromMPos();
		}
		if (gline.has('G92.1')) {
			this._updateMPosFromPos();
			vmState.offset = this.zerocoord();
			vmState.offsetEnabled = false;
			this._updatePosFromMPos();
		}
		if (gline.has('G92.2')) {
			this._updateMPosFromPos();
			vmState.offsetEnabled = false;
			this._updatePosFromMPos();
		}
		if (gline.has('G92.3')) {
			this._updateMPosFromPos();
			vmState.offsetEnabled = true;
			this._updatePosFromMPos();
		}

		// Handle line number
		let lineNum = gline.get('N');
		if (lineNum !== null) vmState.line = lineNum;

		// Handle dwell
		if (gline.has('G4') && gline.has('P')) {
			vmState.totalTime += gline.get('P');
		}

		// Reset coordinate system if using G53
		if (tempCoordSys) this._setCoordSys(origVMState.activeCoordSys);

		// Augment line with state info, and return it
		gline.before = origVMState;
		gline.after = objtools.deepCopy(vmState);
		gline.isMotion = true;
		return gline;
	}

}

module.exports = GcodeVM;
