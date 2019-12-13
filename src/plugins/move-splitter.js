const XError = require('xerror');
const GcodeProcessor = require('../../lib/gcode-processor');
const GcodeLine = require('../../lib/gcode-line');
const GcodeVM = require('../../lib/gcode-vm');
const objtools = require('objtools');

/**
 * This gcode processor will split long linear moves into a series of shorter ones.
 *
 * @class MoveSplitter
 * @constructor
 * @param {Object} options
 *   @param {Number} options.maxMoveLength=10
 */
class MoveSplitter extends GcodeProcessor {

	constructor(options = {}) {
		super(options, 'movesplitter', true);
		this.maxMoveLength = options.maxMoveLength;
		this.vm = new GcodeVM(options);
	}

	processGcode(gline) {
		let startVMState = objtools.deepCopy(this.vm.getState());
		// Run the line through the gcode VM
		let { isMotion, changedCoordOffsets, motionCode } = this.vm.runGcodeLine(gline);
		// Make sure the line represents motion
		if (!isMotion) return gline;
		// If anything regarding changing coordinate systems has changed, ignore the line
		if (changedCoordOffsets) return gline;
		// Get position diffs for all changed axes
		let endVMState = this.vm.getState();
		let axisDiffs = [];
		let numChangedAxes = 0;
		for (let axisNum = 0; axisNum < startVMState.pos.length; axisNum++) {
			if (startVMState.pos[axisNum] !== endVMState.pos[axisNum]) {
				// Moved on this axis
				// If we've never gotten definitive positions for this axis before, ignore the line
				if (!startVMState.hasMovedToAxes[axisNum]) return gline;
				axisDiffs.push(endVMState.pos[axisNum] - startVMState.pos[axisNum]);
				numChangedAxes++;
			} else {
				axisDiffs.push(0);
			}
		}
		if (!numChangedAxes) return gline; // nothing actually moved
		// Make sure we're not in incremental mode
		if (endVMState.incremental) return gline; // incremental mode not supported
		// Make sure the motion mode is one of the supported motion modes
		if (motionCode !== 'G0' && motionCode !== 'G1') return gline;
		// Calculate the distance moved and check if it's above the threshold
		let dist = 0;
		for (let p of axisDiffs) {
			dist += p*p;
		}
		dist = Math.sqrt(dist);
		if (dist <= this.maxMoveLength) return gline;

		// This is a move that needs to be split up.
		
		// Output a version of the original gline without any of the coordinates specified, to set any other modes it may be setting (including feed)
		for (let i = 0; i < axisDiffs.length; i++) {
			gline.set(endVMState.axisLabels[i], null);
		}
		// don't send if line is now empty, or only contains the motion gcode
		if (gline.words.length > 1 || (gline.words.length === 1 && 'G' + gline.get('G') !== motionCode) || gline.comment) {
			gline.addComment('move split');
			this.pushGcode(gline);
		}

		// Output movement segments
		let numMoves = Math.ceil(dist / this.maxMoveLength);
		for (let i = 0; i < numMoves; i++) {
			let newgline = new GcodeLine(motionCode);
			newgline.addComment('split partial move');
			for (let axisNum = 0; axisNum < axisDiffs.length; axisNum++) {
				if (axisDiffs[axisNum]) {
					let moveAxisDiff = (i + 1) * axisDiffs[axisNum] / numMoves;
					let moveAxisCoord = startVMState.pos[axisNum] + moveAxisDiff;
					newgline.set(startVMState.axisLabels[axisNum], moveAxisCoord);
				}
			}
			this.pushGcode(newgline);
		}
		return undefined;
	}

}

module.exports.registerServerComponents = function (tightcnc) {
	tightcnc.registerGcodeProcessor('movesplitter', MoveSplitter);
};

