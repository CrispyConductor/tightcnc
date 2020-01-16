macroMeta({ params: {
	invertAxes: {
		type: 'boolean',
		default: false,
		description: 'If true, expect pins parallel to X axis instead of Y axis.'
	},
	pinDistance: {
		type: 'number',
		default: 40,
		description: 'Nominal distance between pin centers'
	},
	pinDiameter: {
		type: 'number',
		default: 3.175,
		description: 'Diameter of locating pins'
	},
	probeDiameter: {
		type: 'number',
		default: 3.175,
		description: 'Diameter of the probe'
	},
	feed: {
		type: 'number',
		default: 40,
		description: 'Feed rate for probing'
	},
	extraClearance: {
		type: 'number',
		default: 0.5
	}
} });

async function probeAbs(axisNum, pos, throwOnNotTripped = false) {
	await sync();
	let probeTo = [ null, null, null ];
	probeTo[axisNum] = pos;
	try {
		let p = await controller.probe(probeTo, feed);
		return p[axisNum];
	} catch (err) {
		if (err.code === XError.PROBE_NOT_TRIPPED && !throwOnNotTripped) {
			return null;
		} else {
			throw err;
		}
	}
}

async function probeRel(axisNum, offset, throwOnNotTripped = false) {
	await sync();
	return await probeAbs(axisNum, controller.getPos()[axisNum] + offset, throwOnNotTripped);
}

async function moveAbs(axisNum, pos, feed = null) {
	let words = [ [ 'G', feed ? 1 : 0 ], [ axisLabels[axisNum].toUpperCase(), pos ] ];
	if (feed) words.push([ 'F', feed ]);
	push(words);
}

async function moveRel(axisNum, offset, feed = null) {
	await sync();
	await moveAbs(axisNum, controller.getPos()[axisNum] + offset, feed);
}


// Probes towards a pin from 2 opposite sides to determine the central coordinate of the pin
// axisNum is the primary axis to find the center on.  The pin in probed on either side perpendicular to this axis.
// direction indicates which side of the pin (on the perpendicular axis) the machine is currently on.
// A direction of 1 means that the perpendicular axis should move in the positive direction to touch the pin.
// When this is invoked, the machine must already be positioned such that the probe and pin "overlap" on the axis
// (ie, moving in direction on the axis perpendicular to axisNum should result in touching the pin within maxTravel distance)
async function probePinCenter(axisNum = 0, direction = -1, maxTravel = null) {
	let perpAxisNum = axisNum ? 0 : 1;
	if (!maxTravel) maxTravel = pinDiameter;

	// Probe in the axisNum direction until touching the pin; 
	await sync();
	let axisPos1 = controller.getPos()[axisNum];
	let perpAxisPos = await probeRel(perpAxisNum, direction * maxTravel, true);
	// Back up to a clearance position
	await moveRel(perpAxisNum, -direction * (Math.max(pinDiameter, probeDiameter) / 2 + extraClearance));
	await sync();
	let perpClearancePos = controller.getPos()[perpAxisNum];

	// Move to the negative side along axisNum
	let negClearancePos = controller.getPos()[axisNum] - (pinDiameter + probeDiameter + extraClearance);
	let posClearancePos = controller.getPos()[axisNum] + (pinDiameter + probeDiameter + extraClearance);
	await moveAbs(axisNum, negClearancePos);
	// In most cases, we could use perpAxisPos for the probing along axisNum, except for the edge case where we just probed at the exact center already
	// To account for this, add a little bit to perpAxisPos.  Half a radius should work.
	perpAxisPos += direction * pinDiameter / 4;
	// Move to the probing position on the perpendicular axis
	await moveAbs(perpAxisNum, perpAxisPos);
	// Probe toward pin
	let tripPos1 = await probeAbs(axisNum, axisPos1 + pinDiameter / 2, true);
	// Back to clearance
	await moveAbs(axisNum, negClearancePos);
	await moveAbs(perpAxisNum, perpClearancePos);

	// Move to the positive side along axisNum
	await moveAbs(axisNum, posClearancePos);
	// Move to probing position
	await moveAbs(perpAxisNum, perpAxisPos);
	// Probe toward pin
	let tripPos2 = await probeAbs(axisNum, axisPos1 - pinDiameter / 2, true);
	// Back to clearance
	await moveAbs(axisNum, posClearancePos);
	await moveAbs(perpAxisNum, perpClearancePos);

	// Calculate and move to center along axisNum
	let center = (tripPos1 + tripPos2) / 2;
	await moveAbs(axisNum, center);

	// Probe until touching the pin (to determine its location on the perp axis)
	let perpTouchPos = await probeAbs(perpAxisNum, perpAxisPos, true);

	await sync();
	return [ center, perpTouchPos + direction * (pinDiameter + probeDiameter) / 2 ];
}


let pinsAxisNum = invertAxes ? 0 : 1;
let otherAxisNum = invertAxes ? 1 : 0;

// Find the otherAxisNum center coord for the first pin
let [ pin1OtherAxisCenter, pin1PinsAxisCenter ] = await probePinCenter(otherAxisNum, -1);

// Find other pin
let probe2StartPos = pin1PinsAxisCenter + pinDistance - (pinDiameter + probeDiameter) / 2 - pinDiameter / 4;
await sync();
if (probe2StartPos > controller.getPos()[pinsAxisNum]) {
	await moveAbs(pinsAxisNum, probe2StartPos);
} else {
	await moveAbs(pinsAxisNum, pin1PinsAxisCenter + pinDistance / 2);
}
let [ pin2OtherAxisCenter, pin2PinsAxisCenter ] = await probePinCenter(otherAxisNum, 1);

// Calculate center values.  The two otherAxisCenters should be the same, but in case they're slightly off, average them.
let otherAxisCenter = (pin1OtherAxisCenter + pin2OtherAxisCenter) / 2;
let pinsAxisCenter = (pin1PinsAxisCenter + pin2PinsAxisCenter) / 2;
await moveAbs(pinsAxisNum, pinsAxisCenter);
await moveAbs(otherAxisNum, otherAxisCenter);
await sync();

message('Pin probe complete.  Pin skew: ' + Math.abs(pin1OtherAxisCenter - pin2OtherAxisCenter));


