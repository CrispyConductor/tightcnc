const XError = require('xerror');
const objtools = require('objtools');
const GcodeLine = require('./gcode-line');



/**
 * This is a virtual machine that tracks the state of a gcode job as it executes, and annotates all gcode lines
 * with the state of the virtual machine before and after the gcode line executes.  This is necessary to find the actual positions
 * of the machine during a job.
 *
 * This virtual machine is primarily intended for analysis of jobs that are mostly machine movement, but also includes support
 * for some command codes.  Note that it is note a validator, and may not represent actual machine behavior with invalid gcode.
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
 *   @param {TightCNCServer} tightcnc - Server instance.  Can also be provided to get some initial state.
 *   @param {String[]} axisLabels - Override default axis labels.  Defaults come from the controller, or are [ 'x', 'y', 'z' ].
 *   @param {Number} maxFeed - Maximum feed rate, used to calculate time for G0 moves.
 *   @param {Number} minMoveTime - Minimum time to count for a move.  Can be set to a low value to compensate for delays if lots
 *     of small moves aren't filling the controller's buffer.
 */
class GcodeVM {

	constructor(options = {}) {
		this.options = options;
		if (!options.noInit) this.init();
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

	/**
	 * Initialize the VM state if not performed in the constructor.
	 *
	 * @method init
	 */
	init() {
		// note: if tightcnc is passed in as an option, and it has a controller attached, get initial values from that
		let controller = this.options.controller || (this.options.tightcnc && this.options.tightcnc.controller) || {};
		let vmState = {};
		this.vmState = vmState;
		this.syncStateToMachine();
		vmState.coord = this.coord.bind(this);
		vmState.totalTime = 0; // seconds
		vmState.bounds = [ this.zerocoord(null), this.zerocoord(null) ]; // min and max points
		vmState.mbounds = [ this.zerocoord(null), this.zerocoord(null) ]; // bounds for machine coordinates
		vmState.lineCounter = 0;
		vmState.hasMovedToAxes = this.zerocoord(false); // true for each axis that we've moved on, and have a definite position for
	}

	/**
	 * Returns gcode needed to set a physical machine's state to this virtual machine's state.
	 *
	 * Currently supported state properties:
	 * - spindle (includes spindleSpeed, spindleDirection)
	 * - coolant
	 * - feed
	 * - incremental
	 * - motionMode
	 * - arcPlane
	 * - inverseFeed
	 * - units
	 *
	 * @method syncMachineToState
	 * @param {Object} options
	 *   @param {Object} [options.vmState=null] - Use a GcodeVM state object instead of this instance's current state
	 *   @param {String[]) [options.include] - List of state properties to include from those available.
	 *   @param {String[]} [options.exclude] - List of state properties to exclude from those available.
	 * @return {GcodeLine[]} - Array of GcodeLines
	 */
	syncMachineToState(options = {}) {
		const shouldInclude = (prop) => {
			if (!options.include && !options.exclude) return true;
			if (options.include && options.exclude && options.include.indexOf(prop) !== -1 && options.exclude.indexOf(prop) === -1) return true;
			if (!options.include && options.exclude && options.exclude.indexOf(prop) === -1) return true;
			if (options.include && !options.exclude && options.include.indexOf(prop) !== -1) return true;
			return false;
		};
		let vmState = options.vmState || this.vmState;
		let ret = [];

		// motion mode
		if (vmState.motionMode && shouldInclude('motionMode')) {
			ret.push(new GcodeLine(vmState.motionMode));
		}

		// feed rate
		if (vmState.feed && shouldInclude('feed')) {
			ret.push(new GcodeLine('F' + vmState.feed));
		}

		// arc plane
		if (typeof vmState.arcPlane === 'number' && shouldInclude('arcPlane')) {
			if (vmState.arcPlane === 0) {
				ret.push(new GcodeLine('G17'));
			} else if (vmState.arcPlane === 1) {
				ret.push(new GcodeLine('G18'));
			} else if (vmState.arcPlane === 2) {
				ret.push(new GcodeLine('G19'));
			}
		}

		// incremental mode
		if (typeof vmState.incremental === 'boolean' && shouldInclude('incremental')) {
			if (vmState.incremental) {
				ret.push(new GcodeLine('G91'));
			} else {
				ret.push(new GcodeLine('G90'));
			}
		}

		// feed rate mode
		if (typeof vmState.inverseFeed === 'boolean' && shouldInclude('inverseFeed')) {
			if (vmState.inverseFeed) {
				ret.push(new GcodeLine('G93'));
			} else {
				ret.push(new GcodeLine('G94'));
			}
		}

		// units
		if (vmState.units && shouldInclude('units')) {
			if (vmState.units === 'in') {
				ret.push(new GcodeLine('G20'));
			} else if (vmState.units === 'mm') {
				ret.push(new GcodeLine('G21'));
			}
		}

		// spindle
		if (vmState.spindle !== null && vmState.spindle !== undefined && shouldInclude('spindle')) {
			if (vmState.spindle) {
				let word = (vmState.spindleDirection === -1) ? 'M4' : 'M3';
				let sword = vmState.spindleSpeed ? (' S' + vmState.spindleSpeed) : '';
				ret.push(new GcodeLine(word + sword));
			} else {
				ret.push(new GcodeLine('M5'));
			}
		}

		// coolant
		if (vmState.coolant !== null && vmState.coolant !== undefined && shouldInclude('coolant')) {
			if (vmState.coolant === 1 || vmState.coolant === 3) {
				ret.push(new GcodeLine('M7'));
			}
			if (vmState.coolant === 2 || vmState.coolant === 3) {
				ret.push(new GcodeLine('M8'));
			}
			if (!vmState.coolant) {
				ret.push(new GcodeLine('M9'));
			}
		}

		return ret;
	}

	syncStateToMachine(options = {}) {
		const shouldInclude = (prop) => {
			if (!options.include && !options.exclude) return true;
			if (options.include && options.exclude && options.include.indexOf(prop) !== -1 && options.exclude.indexOf(prop) === -1) return true;
			if (!options.include && options.exclude && options.exclude.indexOf(prop) === -1) return true;
			if (options.include && !options.exclude && options.include.indexOf(prop) !== -1) return true;
			return false;
		};

		let controller = options.controller || this.options.controller || (this.options.tightcnc && this.options.tightcnc.controller) || {};
		let vmState = options.vmState || this.vmState;

		if (shouldInclude('axisLabels')) vmState.axisLabels = this.options.axisLabels || controller.axisLabels || [ 'x', 'y', 'z' ];
		if (shouldInclude('mpos')) vmState.mpos = controller.mpos || this.zerocoord();
		if (shouldInclude('pos')) vmState.pos = (controller.getPos && controller.getPos()) || controller.pos || this.zerocoord();
		if (shouldInclude('activeCoordSys')) vmState.activeCoordSys = (typeof controller.activeCoordSys === 'number') ? controller.activeCoordSys : null;
		if (shouldInclude('coordSysOffsets')) vmState.coordSysOffsets = controller.coordSysOffsets || [ this.zerocoord() ];
		if (shouldInclude('offset')) vmState.offset = controller.offset || this.zerocoord();
		if (shouldInclude('offsetEnabled')) vmState.offsetEnabled = controller.offsetEnabled || false;
		if (shouldInclude('storedPositions')) vmState.storedPositions = controller.storedPositions || [ this.zerocoord(), this.zerocoord() ];
		if (shouldInclude('units')) vmState.units = controller.units || 'mm';
		if (shouldInclude('feed')) vmState.feed = controller.feed || this.options.maxFeed || 1000;
		if (shouldInclude('incremental')) vmState.incremental = controller.incremental || false;
		if (shouldInclude('coolant')) vmState.coolant = controller.coolant || false;
		if (shouldInclude('spindle')) vmState.spindle = controller.spindle || false;
		if (shouldInclude('line')) vmState.line = controller.line || 0;
		if (shouldInclude('spindle')) vmState.spindleDirection = controller.spindleDirection || 1;
		if (shouldInclude('spindle')) vmState.spindleSpeed = controller.spindleSpeed || null;
		if (shouldInclude('inverseFeed')) vmState.inverseFeed = controller.inverseFeed || false;
		if (shouldInclude('motionMode')) vmState.motionMode = controller.motionMode || null;
		if (shouldInclude('arcPlane')) vmState.arcPlane = controller.arcPlane || 0;
	}

	getState() {
		return this.vmState;
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
			}
			travel = Math.sqrt(travelSq);
		}
		// Get feed if not provided
		if (!feed) feed = this.options.maxFeed || 1000;
		let moveTime;
		if (this.vmState.inverseFeed) {
			// Handle time calc if inverse feed
			let minTime = travel / (this.options.maxFeed || 1000);
			if (!feed) feed = minTime;
			if (feed < minTime) feed = minTime;
			moveTime = feed * 60;
		} else {
			// Handle time calc if normal feed
			if (!feed) feed = this.options.maxFeed || 1000;
			//moveTime = (travel / feed) * 60; // <-- naive (infinite acceleration) move time calculation
			// NOTE: The below code to account for acceleration could certainly be improved; but to large extent, it's
			// actually controller-specific.  The accuracy of these time estimates will vary.
			// Approximate move time (making a few not necessarily true assumptions) is calculated by
			// starting with the move's time if it were operating at the full feed rate the whole time (infinite acceleration),
			// then deducting the extra time it would have taken to change from the previous move's feed to this move's feed.
			// This is calculated on a per-axis basis, taking the per-axis components of the feed rate.
			if (!this._lastMoveAxisFeeds) this._lastMoveAxisFeeds = this.zerocoord();
			// calculate linear distance travelled (this, and other parts of this method, will need to be adjusted for nonlinear moves)
			let linearDist = 0;
			for (let axisNum = 0; axisNum < to.length; axisNum++) {
				let d = to[axisNum] - this.vmState.pos[axisNum];
				linearDist += d*d;
			}
			linearDist = Math.sqrt(linearDist);
			// Determine the axis that will require the most amount of time to change velocity
			let maxAccelTime = 0; // minutes
			let accel = this.options.acceleration || 100000; // in mm / min^2
			for (let axisNum = 0; axisNum < to.length; axisNum++) {
				let diff = to[axisNum] - this.vmState.pos[axisNum];
				// calculate feed component for this axis (may be negative to indicate negative direction)
				let axisFeed = diff / linearDist * feed; // in mm/min
				// Get and update the last move's axis feed rate
				let lastMoveAxisFeed = this._lastMoveAxisFeeds[axisNum];
				this._lastMoveAxisFeeds[axisNum] = axisFeed;
				// calculate amount of time it would take to accelerate between the feeds
				let accelTime = Math.abs(axisFeed - lastMoveAxisFeed) / accel; // min
				if (accelTime > maxAccelTime) maxAccelTime = accelTime;
			}
			// Determine the distance travelled for that acceleration time
			let accelDist = Math.abs(feed * (1/2)*accel*(maxAccelTime*maxAccelTime));
			if (accelDist > travel) accelDist = travel;
			// Calcualte the base move time (time when travelling over move at max feed, minus the distances for acceleration)
			moveTime = (travel - accelDist) / feed; // minutes
			// Add time to accelerate
			moveTime += maxAccelTime;
			// convert to seconds
			moveTime *= 60;
		}
		if (this.options.minMoveTime && moveTime < this.options.minMoveTime) {
			moveTime = this.options.minMoveTime;
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
		// Update hasMovedToAxes with axes we definitively know positions for
		if (!incremental) {
			for (let axisNum = 0; axisNum < axisFlags.length; axisNum++) {
				if (axisFlags[axisNum]) {
					this.vmState.hasMovedToAxes[axisNum] = true;
				}
			}
		}
	}

	_setCoordSys(num) {
		this.vmState.pos = this._convertCoordSys(this.vmState.pos, this.vmState.activeCoordSys, num, null, null); // note, offsets from vmState.offset are cancelled out so don't need to be passed
		this.vmState.activeCoordSys = num;
	}

	/**
	 * Run a line of gcode through the VM.
	 *
	 * @method runGcodeLine
	 * @param {GcodeLine} gline - A parsed GcodeLine instance
	 * @return {Object} - Contains keys 'state' (new state), 'isMotion' (whether the line indicates motion)
	 */
	runGcodeLine(gline) {
		// This is NOT a gcode validator.  Input gcode is expected to be valid and well-formed.
		//
		let vmState = this.vmState;
		let origCoordSys = vmState.activeCoordSys;
		let changedCoordOffsets = false;

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

		// Check if this is simple motion that can skip extra checks (for efficiency in the most common case)
		let isSimpleMotion = motionCode && (motionCode === 'G0' || motionCode === 'G1') && (gline.has(motionCode) ? 1 : 0) + (gline.has('F') ? 1 : 0) + (gline.has('N') ? 1 : 0) + hasCoords.length === gline.words.length;

		// Check for other codes that set modals
		let tempCoordSys = false;
		let wordF = gline.get('F');
		if (typeof wordF === 'number') vmState.feed = wordF;
		if (!isSimpleMotion) {
			if (gline.has('G17')) vmState.arcPlane = 0;
			if (gline.has('G18')) vmState.arcPlane = 1;
			if (gline.has('G19')) vmState.arcPlane = 2;
			if (gline.has('G20')) vmState.units = 'in';
			if (gline.has('G21')) vmState.units = 'mm';
			for (let i = 0; i < 6; i++) {
				if (gline.has('G' + (54 + i))) {
					this._setCoordSys(i);
					changedCoordOffsets = true;
				}
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
				changedCoordOffsets = true;
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
			if (gline.has('G53')) {
				tempCoordSys = true;
				this._setCoordSys(null);
			}
		}

		// Handle motion
		let doMotion = motionCode;
		let isMotion = false;
		if (!isSimpleMotion) {
			if (gline.has('G28')) doMotion = 'G28';
			if (gline.has('G30')) doMotion = 'G30';
		}
		if (doMotion === 'G0') {
			if (hasCoords.length) {
				this._processMove(coordPos, coordFlags, null, null, vmState.incremental);
				isMotion = true;
			}
		} else if (doMotion === 'G1') {
			if (hasCoords.length) {
				this._processMove(coordPos, coordFlags, vmState.feed, null, vmState.incremental);
				isMotion = true;
			}
		} else if ((doMotion === 'G2' || doMotion === 'G3')) {
			if (hasCoords.length) {
				// TODO: calculate travel distance properly here
				this._processMove(coordPos, coordFlags, vmState.feed, null, vmState.incremental);
				isMotion = true;
			}
		} else if (doMotion === 'G28' || doMotion === 'G30') {
			if (hasCoords.length) {
				this._processMove(coordPos, coordFlags, vmState.feed, null, vmState.incremental);
			}
			let storedPos = vmState.storedPositions[(doMotion === 'G28') ? 0 : 1];
			storedPos = this._convertCoordSys(storedPos, null, vmState.activeCoordSys, null, vmState.offsetEnabled && vmState.offset);
			this._processMove(storedPos, null, vmState.feed, null, false);
			isMotion = true;
		} else if (doMotion) {
			throw new XError(XError.UNSUPPORTED_OPERATION, 'Unsupported motion gcode ' + doMotion + ': ' + gline.toString());
		}

		if (!isSimpleMotion) {
			// Handle G10 L2
			if (gline.has('G10') && gline.has('L2') && gline.has('P') && hasCoords.length) {
				this._updateMPosFromPos();
				let newOffset = coordPosSparse.map((v) => (v || 0));
				let coordSys = gline.get('P') - 1;
				vmState.coordSysOffsets[coordSys] = newOffset;
				this._updatePosFromMPos();
				changedCoordOffsets = true;
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
				changedCoordOffsets = true;
			}

			// Handle G92
			if (gline.has('G92')) {
				this._updateMPosFromPos();
				vmState.offset = coordPosSparse.map((v) => (v || 0));
				vmState.offsetEnabled = true;
				this._updatePosFromMPos();
				changedCoordOffsets = true;
			}
			if (gline.has('G92.1')) {
				this._updateMPosFromPos();
				vmState.offset = this.zerocoord();
				vmState.offsetEnabled = false;
				this._updatePosFromMPos();
				changedCoordOffsets = true;
			}
			if (gline.has('G92.2')) {
				this._updateMPosFromPos();
				vmState.offsetEnabled = false;
				this._updatePosFromMPos();
				changedCoordOffsets = true;
			}
			if (gline.has('G92.3')) {
				this._updateMPosFromPos();
				vmState.offsetEnabled = true;
				this._updatePosFromMPos();
				changedCoordOffsets = true;
			}
			// Handle dwell
			if (gline.has('G4') && gline.has('P')) {
				vmState.totalTime += gline.get('P');
			}
		}

		// Handle line number
		let lineNum = gline.get('N');
		if (lineNum !== null) vmState.line = lineNum;

		// Add to line counter
		vmState.lineCounter++;

		// Reset coordinate system if using G53
		if (tempCoordSys) this._setCoordSys(origCoordSys);

		// Return state info
		return {
			state: vmState, // VM state after executing line
			isMotion: isMotion, // whether the line represents motion
			motionCode: motionCode, // If motion, the G code associated with the motion
			changedCoordOffsets: changedCoordOffsets // whether or not anything was changed with coordinate systems
		};
	}

}

module.exports = GcodeVM;

