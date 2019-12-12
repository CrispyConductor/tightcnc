const cross = require('cross');
const Operation = require('../server/operation');
const commonSchema = require('common-schema');
const XError = require('xerror');
const objtools = require('objtools');
const KDTree = require('kd-tree-javascript').kdTree;
const fs = require('fs');


class SurfaceLevelMap {

	constructor(points = []) {
		this.pointList = points.slice(); // An array of [x, y, z] points where the z is the probed height
		const dist = (a, b) => {
			return Math.pow(a[0] - b[0], 2) + Math.pow(a[1] - b[1], 2);
		};
		this.kdtree = new KDTree(points, dist, [ 0, 1 ]);
	}

	addPoint(point) {
		this.pointList.push(point);
		this.kdtree.insert(point);
	}

	getPoints() {
		return this.pointList;
	}

	// Given a point [ x, y ], predicts the Z of that point based on the known surface level map.  If data
	// is insufficient to predict the Z, null is returned.
	predictZ(point) {
		if (!this.pointList.length) return null;
		// Check for exact hit
		let theNearest = this.getNearestPoints(point, 1);
		if (theNearest[0][0] === point[0] && theNearest[0][1] === point[1]) return theNearest[0][2];
		// Predict based on plane of 3 nearest points
		if (this.pointList.length >= 3) {
			let nps = this.getNearest3PlanePoints(point);
			if (nps) return this._planeZAtPoint(point, nps[0], nps[1]);
		} else if (this.pointList.length < 2) {
			return null;
		}
		// There are no suitable plane-defining points.  But it's possible we might still be able to
		// predict the Z of point ifs x,y falls along the line of known points.
		let nearest2 = this.getNearestPoints(point, 2);
		let zdiff = nearest2[1][2] - nearest2[0][2];
		let ydiff = nearest2[1][1] - nearest2[0][1];
		let xdiff = nearest2[1][0] - nearest2[0][0];
		if (xdiff === 0) {
			// line is parallel to Y axis; handle separately to avoid divide by 0
			if (point[0] !== nearest2[0][0] || ydiff === 0) {
				// point not on line
				return null;
			}
			let z = zdiff * (point[1] - nearest2[0][1]) / ydiff + nearest2[0][2];
			if (z === 0) z = 0; // check to avoid -0
			return z;
		} else {
			let xySlope = ydiff / xdiff;
			let xyIntercept = nearest2[0][1] - xySlope * nearest2[0][0];
			if (xySlope * point[0] + xyIntercept !== point[1]) {
				// point not on line
				return null;
			}
			let z = zdiff * (point[0] - nearest2[0][0]) / xdiff + nearest2[0][2];
			if (z === 0) z = 0; // check to avoid -0
			return z;
		}
		
	}

	// Returns the n nearest points to the given [x, y], sorted from nearest to farthest
	getNearestPoints(point, n = 3) {
		let results = this.kdtree.nearest(point, n);
		results.sort((a, b) => {
			return a[1] - b[1];
		});
		return results.map((r) => r[0]);
	}

	// Returns the nearest 3 points in XY plane that are not colinear and define a plane that is not orthogonal to the XY plane, or null if no such 3 exist
	// Point is [x, y].  Return value is null or [ pointArray, normalVector ]
	getNearest3PlanePoints(point) {
		// Keep a tally of the closest 2 points, then keep searching for a third that's not colinear with the first two
		let curPoints = null;
		let vA;
		let crossResult = [];
		for (let n = 3; n <= this.pointList.length; n++) {
			let results = this.getNearestPoints(point, n);
			if (curPoints) {
				curPoints[2] = results[n - 1];
			} else {
				curPoints = results.slice();
				vA = [ curPoints[1][0] - curPoints[0][0], curPoints[1][1] - curPoints[0][1], curPoints[1][2] - curPoints[0][2] ];
			}
			// Check if orthogonal to XY or colinear
			let vB = [ curPoints[2][0] - curPoints[0][0], curPoints[2][1] - curPoints[0][1], curPoints[2][2] - curPoints[0][2] ];
			let norm = cross(crossResult, vA, vB);
			if (norm[2] !== 0) {
				// not orthogonal to XY
				if (norm[0] !== 0 || norm[1] !== 0) {
					// not colinear
					return [ curPoints, norm ];
				}
			}
		}
		return null;
	}

	/*
	 * Given 3 points on a plane in the form [ [x1, y1, z1], [x2, y2, z2], [x3, y3, z3] ], and a single 2D point [x0, y0],
	 * this returns the Z coordinate of the 2D point on the 3D plane specified by the 3 points.  This returns null in
	 * cases that 2 of the plane points are colinear (and do not specify a plane), or the point given cannot fall on that plane.
	 */
	_planeZAtPoint(point, planePoints, norm = null) {
		if (!norm) {
			let vA = [ planePoints[1][0] - planePoints[0][0], planePoints[1][1] - planePoints[0][1], planePoints[1][2] - planePoints[0][2] ];
			let vB = [ planePoints[2][0] - planePoints[0][0], planePoints[2][1] - planePoints[0][1], planePoints[2][2] - planePoints[0][2] ];
			norm = cross([], vA, vB);
		}
		if (norm[0] === 0 && norm[1] === 0 && norm[2] === 0) return null; // points are colinear
		if (norm[2] === 0) return null; // point does not intersect plane
		let d = -(norm[0] * planePoints[0][0] + norm[1] * planePoints[0][1] + norm[2] * planePoints[0][2]);
		let z = (-d - norm[0] * point[0] - norm[1] * point[1]) / norm[2];
		if (z === 0) return 0; else return z; // check to avoid -0
	}

}

module.exports.SurfaceLevelMap = SurfaceLevelMap;

let surfaceProbeStatus = {
	state: 'none'
};

let surfaceProbeResults = null;

function startProbeSurface(tightcnc, options) {
	if (surfaceProbeStatus.state === 'running') throw new XError(XError.INTERNAL_ERROR, 'Surface probe already running');
	surfaceProbeStatus = { state: 'running' };

	// Calculate number of probe points along X and Y, and actual probe spacing
	let lowerBound = options.bounds[0];
	let upperBound = options.bounds[1];
	let probeAreaSizeX = upperBound[0] - lowerBound[0];
	let probeAreaSizeY = upperBound[1] - lowerBound[1];
	if (probeAreaSizeX <= 0 || probeAreaSizeY <= 0) throw new XError(XError.INVALID_ARGUMENT, 'Invalid bounds');
	let probePointsX = Math.ceil(probeAreaSizeX / options.probeSpacing) + 1;
	let probePointsY = Math.ceil(probeAreaSizeY / options.probeSpacing) + 1;
	if (probePointsX < 2) probePointsX = 2;
	if (probePointsY < 2) probePointsY = 2;
	let spacingX = probeAreaSizeX / (probePointsX - 1);
	let spacingY = probeAreaSizeY / (probePointsY - 1);
	surfaceProbeStatus.resultFilename = options.surfaceMapFilename;
	surfaceProbeStatus.probePointsX = probePointsX;
	surfaceProbeStatus.probePointsY = probePointsY;
	surfaceProbeStatus.spacingX = spacingX;
	surfaceProbeStatus.spacingY = spacingY;
	let startPoint = [ lowerBound[0], lowerBound[1] ];
	surfaceProbeStatus.startPoint = startPoint;
	surfaceProbeStatus.probePoints = probePointsX * probePointsY;
	surfaceProbeStatus.currentProbePoint = 0;
	surfaceProbeStatus.percentComplete = 0;

	const sendMove = (x, y, z) => {
		let gcode = 'G0';
		if (typeof x === 'number') gcode += ' X' + x.toFixed(3);
		if (typeof y === 'number') gcode += ' Y' + y.toFixed(3);
		if (typeof z === 'number') gcode += ' Z' + z.toFixed(3);
		tightcnc.controller.send(gcode);
	};

	const runProbeSurface = async () => {
		let slm = new SurfaceLevelMap();

		// Move to above starting point
		sendMove(null, null, options.clearanceHeight);
		sendMove(startPoint[0], startPoint[1], null);
		let currentZ = options.clearanceHeight;

		// Loop through each point
		for (let pointNum = 0; pointNum < probePointsX * probePointsY; pointNum++) {
			surfaceProbeStatus.currentProbePoint = pointNum;
			surfaceProbeStatus.percentComplete = pointNum / (probePointsX * probePointsY) * 100;

			// Calculate the point number X and point number Y in such a way to move the machine in a "zig zag" pattern
			let pointNumX = Math.floor(pointNum / probePointsY);
			let pointNumY = pointNum - pointNumX * probePointsY;
			if (pointNumX % 2 === 1) pointNumY = probePointsY - 1 - pointNumY;
			let pointPosX = pointNumX * spacingX;
			let pointPosY = pointNumY * spacingY;

			// Calculate the clearance height to get to this point.  If autoClearance is disabled, this is just the predefined
			// clearance.  For autoClearance, the height is determined by predicting the height of the next point and adding autoClearanceMin.
			let clearanceZ = options.clearanceHeight;
			if (options.autoClearance && pointNum >= 2) {
				// Try to predict the z of the next probe point based on existing probe data, and use a smaller clearance to that
				let predictedZ = slm.predictZ([ pointPosX, pointPosY ]);
				if (typeof predictedZ === 'number') clearanceZ = predictedZ + options.autoClearanceMin;
			}

			// Move to above the next point
			if (clearanceZ > currentZ) sendMove(null, null, clearanceZ);
			sendMove(pointPosX, pointPosY, null);
			if (clearanceZ < currentZ) sendMove(null, null, clearanceZ);

			// Probe down towards the point
			let tripPos = await tightcnc.controller.probe([ null, null, options.probeMinZ ]);
			let tripZ = tripPos[2];

			// Add point to list of points
			slm.addPoint([ pointPosX, pointPosY, tripZ ]);
			
			// Move up to minimum clearance
			currentZ = options.autoClearance ? (tripZ + options.autoClearanceMin) : options.clearanceHeight;
			sendMove(null, null, currentZ);
		}

		// Probing complete.  Move back to full clearance, and the lower bound XY
		sendMove([ null, null, options.clearanceHeight ]);
		sendMove([ lowerBound[0], lowerBound[0], null ]);

		// Save the probing results
		surfaceProbeResults = {
			bounds: options.bounds,
			probePointsX,
			probePointsY,
			time: new Date().toISOString(),
			points: slm.getPoints()
		};
		if (options.surfaceMapFilename) {
			await new Promise((resolve, reject) => {
				fs.writeFile(options.surfaceMapFilename, JSON.stringify(surfaceProbeResults, null, 2), (err) => {
					if (err) reject(new XError(XError.INTERNAL_ERROR, 'Error saving probe result file', err));
					else resolve(surfaceProbeResults);
				});
			});
		}
	};

	// Run the actual process asynchronously, reporting progress via status updates
	runProbeSurface()
		.then(() => {
			surfaceProbeStatus.state = 'complete';
			surfaceProbeStatus.currentProbePoint = probePointsX * probePointsY - 1;
			surfaceProbeStatus.percentComplete = 100;
		})
		.catch((err) => {
			surfaceProbeStatus.state = 'error';
			surfaceProbeStatus.error = err.toObject ? err.toObject() : ('' + err);
		});
}

function getProbeStatus() {
	if (surfaceProbeStatus.state === 'none') return null;
	return surfaceProbeStatus;
}

class OpProbeSurface extends Operation {

	constructor(tightcnc, config) {
		super(tightcnc, config);
	}

	async _getBounds(params) {
		if (params.bounds) return params.bounds;
		if (!params.gcodeFilename) throw new XError(XError.BAD_REQUEST, 'Must supply either bounds or gcodeFilename');
		let dryRunResults = await this.tightcnc.jobManager.dryRunJob({ filename: params.gcodeFilename });
		let bounds = objtools.getPath(dryRunResults, 'gcodeProcessors.final-job-vm.bounds');
		if (!bounds) throw new XError(XError.INTERNAL_ERROR, 'Could not determine bounds from gcode file');
		return bounds;
	}

	async run(params) {
		let options = objtools.deepCopy(params);
		options.bounds = await this._getBounds(params);
		startProbeSurface(this.tightcnc, options);
		return surfaceProbeStatus;
	}

	getParamSchema() {
		return {
			surfaceMapFilename: {
				type: String,
				description: 'Filename to save the resulting surface map to'
			},
			bounds: {
				type: 'array',
				elements: {
					type: 'array',
					elements: Number,
					validate(val) {
						if (val.length < 2) throw new commonSchema.FieldError('invalid', 'Bounds points must have at least 2 coordinates');
					}
				},
				validate(val) {
					if (val.length !== 2) throw new commonSchema.FieldError('invalid', 'Bounds must have 2 elements');
				},
				description: 'Bounds to run surface probe on'
			},
			gcodeFilename: {
				type: String,
				description: 'Can be supplied instead of bounds to automatically determine bounds'
			},
			probeSpacing: {
				type: Number,
				default: this.config.defaultOptions.probeSpacing,
				description: 'Maximum grid separation between probe points'
			},
			probeFeed: {
				type: Number,
				default: this.config.defaultOptions.probeFeed,
				description: 'Feed rate for probing'
			},
			clearanceHeight: {
				type: Number,
				default: this.config.defaultOptions.clearanceHeight,
				description: 'Clearance Z for moving across surface'
			},
			autoClearance: {
				type: Boolean,
				default: this.config.defaultOptions.autoClearance,
				description: 'Whether to automatically adjust clearance height based on known probe points to optimize speed'
			},
			autoClearanceMin: {
				type: Number,
				default: this.config.defaultOptions.autoClearanceMin,
				description: 'Minimum amount of clearance when using autoClearance'
			},
			probeMinZ: {
				type: Number,
				default: this.config.defaultOptions.probeMinZ,
				description: 'Minimum Z value to probe toward.  Error if this Z is reached without the probe tripping.'
			}
		};
	}

}

module.exports.registerServerComponents = function (tightcnc) {
	tightcnc.registerOperation('probeSurface', OpProbeSurface);
	tightcnc.on('statusRequest', (status) => {
		let probeStatus = getProbeStatus();
		if (probeStatus) {
			status.probeSurface = probeStatus;
		}
	});
};

