const basepath = process.env.APPDATA || process.env.HOME || '/tmp';
const path = require('path');

module.exports = {
	enableServer: false,
	authKey: 'abc123',
	serverPort: 2363,
	host: 'http://localhost',
	baseDir: path.resolve(basepath, 'tightcnc'),
	controller: 'TinyG',
	controllers: {
		TinyG: {
			// serial port settings
			port: '/dev/ttyUSB0',
			baudRate: 115200,
			dataBits: 8,
			stopBits: 1,
			parity: 'none',
			rtscts: true,
			xany: false,

			usedAxes: [ true, true, true, false, false, false ], // which axes of xyzabc are actually used
			homableAxes: [ true, true, true ], // which axes can be homed

			// This parameter governs how "aggressive" we can be with queueing data to the device.  The tightcnc controller
			// software already adjusts data queueing to make sure front-panel commands can be immediately handled, but
			// sometimes the tinyg seems to get desynced, and on occasion, it seems to crash under these circumstances
			// (with an error similar to "cannot get planner buffer").  If this is happening to you, try reducing this number.
			// The possible negative side effect is that setting this number too low may cause stuttering with lots of fast
			// moves.  Setting this to 4 is the equivalent of the tinyg "line mode" protocol.
			maxUnackedRequests: 32
		},
		grbl: {
			// serial port settings
			port: '/dev/ttyACM1',
			baudRate: 115200,
			dataBits: 8,
			stopBits: 1,
			parity: 'none',

			usedAxes: [ true, true, true ],
			homableAxes: [ true, true, true ],

		}
	},
	paths: {
		data: 'data',
		log: 'log',
		macro: 'macro'
	},
	operations: {
		probeSurface: {
			defaultOptions: {
				probeSpacing: 10,
				probeFeed: 25,
				clearanceHeight: 2,
				autoClearance: true,
				autoClearanceMin: 0.5,
				probeMinZ: -2,
				numProbeSamples: 3,
				extraProbeSampleClearance: 0.4
			}
		}
	},
	logger: {
		maxFileSize: 1000000,
		keepFiles: 2
	},
	recovery: {
		// rewind this number of seconds before the point where the job stopped
		backUpTime: 3,
		// additionall back up for this number of lines before that (to account for uncertainty in which lines have been executed)
		backUpLines: 10,
		// This is a list of gcode lines to execute to move the machine into a clearance position where it won't hit the workpiece
		// The values {x}, {y}, etc. are replaced with the coordinates of the position (touching the workpiece) to resume the job.
		moveToClearance: [
			'G53 G0 Z0',
			'G0 X${x} Y${y}'
		],
		// List of gcode lines to execute to move from the clearance position to the position to restart the job.
		moveToWorkpiece: [
			'G1 Z${z}'
		]
	},
	toolChange: {
		preToolChange: [
			'G53 G0 Z0',
			'G53 G0 X0 Y0'
		],
		postToolChange: [
			'G53 G0 Z0',
			'G0 X${x} Y${y}',
			'G1 Z${z + 0.5}'
		],
		// Which axis number tool offsets apply to (in standard config, Z=2)
		toolOffsetAxis: 2,
		negateToolOffset: false
	},
	enableDebug: false,
	debugToStdout: false,
	consoleui: {
		logDir: path.resolve(basepath, 'tightcnc-consoleui'),
		log: {
			updateInterval: 250,
			updateBatchLimit: 200,
			bufferMaxSize: 500000,
			messageUpdateInterval: 1000
		},
		control: {
			keybinds: {
				'exitMode': {
					keys: [ 'escape' ],
					keyNames: [ 'Esc' ],
					label: 'Home',
					action: {
						exitMode: true
					}
				},
				'x-': {
					keys: [ 'a', 'left' ],
					keyNames: [ 'Left', 'a' ],
					label: 'X-',
					action: {
						realTimeMove: {
							mult: -1,
							axis: 0
						}
					}
				},
				'x+': {
					keys: [ 'd', 'right' ],
					keyNames: [ 'Right', 'd' ],
					label: 'X+',
					action: {
						realTimeMove: {
							mult: 1,
							axis: 0
						}
					}
				},
				'y-': {
					keys: [ 's', 'down' ],
					keyNames: [ 'Down', 's' ],
					label: 'Y-',
					action: {
						realTimeMove: {
							mult: -1,
							axis: 1
						}
					}
				},
				'y+': {
					keys: [ 'w', 'up' ],
					keyNames: [ 'Up', 'w' ],
					label: 'Y+',
					action: {
						realTimeMove: {
							mult: 1,
							axis: 1
						}
					}
				},
				'z-': {
					keys: [ 'f', 'pagedown' ],
					keyNames: [ 'PgDn', 'f' ],
					label: 'Z-',
					action: {
						realTimeMove: {
							mult: -1,
							axis: 2
						}
					}
				},
				'z+': {
					keys: [ 'r', 'pageup' ],
					keyNames: [ 'PgUp', 'r' ],
					label: 'Z+',
					action: {
						realTimeMove: {
							mult: 1,
							axis: 2
						}
					}
				},
				'inc-': {
					keys: [ '-' ],
					keyNames: [ '-' ],
					label: [ 'Inc-' ],
					action: {
						inc: {
							mult: 0.1
						}
					}
				},
				'inc+': {
					keys: [ '+', '=' ],
					keyNames: [ '+' ],
					label: [ 'Inc+' ],
					action: {
						inc: {
							mult: 10
						}
					}
				},
				'axisX': {
					keys: [ 'x' ],
					keyNames: [ 'x' ],
					label: 'X Only',
					action: {
						onlyAxis: {
							axis: 0
						}
					}
				},
				'axisY': {
					keys: [ 'y' ],
					keyNames: [ 'y' ],
					label: 'Y Only',
					action: {
						onlyAxis: {
							axis: 1
						}
					}
				},
				'axisZ': {
					keys: [ 'z' ],
					keyNames: [ 'z' ],
					label: 'Z Only',
					action: {
						onlyAxis: {
							axis: 2
						}
					}
				},
				'setOrigin': {
					keys: [ 'o' ],
					keyNames: [ 'o' ],
					label: 'Set Origin',
					action: {
						setOrigin: true
					}
				},
				'homeMachine': {
					keys: [ 'h' ],
					keyNames: [ 'h' ],
					label: 'Home Mach.',
					action: {
						home: true
					}
				},
				'setMachineHome': {
					keys: [ 'm' ],
					keyNames: [ 'm' ],
					label: 'Set Mach. Home',
					action: {
						setMachineHome: true
					}
				},
				'goOrigin': {
					keys: [ 'g' ],
					keyNames: [ 'g' ],
					label: 'GoTo Origin',
					action: {
						goOrigin: true
					}
				},
				'probeZ': {
					keys: [ 'p' ],
					keyNames: [ 'p' ],
					label: 'Probe Z',
					action: {
						probe: {
							mult: -1,
							axis: 2,
							feed: 25
						}
					}
				},
				'hold': {
					keys: [ ',', '<', '!' ],
					keyNames: [ ',' ],
					label: 'Feed Hold',
					action: {
						operation: {
							name: 'hold',
							params: {}
						}
					}
				},
				'resume': {
					keys: [ '.', '>', '~' ],
					keyNames: [ '.' ],
					label: 'Resume',
					action: {
						operation: {
							name: 'resume',
							params: {}
						}
					}
				},
				'cancel': {
					keys: [ '/', '?', '%' ],
					keyNames: [ '/' ],
					label: 'Cancel',
					action: {
						operation: {
							name: 'cancel',
							params: {}
						}
					}
				},
				'sendline': {
					keys: [ 'enter' ],
					keyNames: [ 'Enter' ],
					label: 'Send Line',
					action: {
						sendTextbox: true
					}
				},
				'resetMachine': {
					keys: [ 'delete' ],
					keyNames: [ 'Del' ],
					label: 'Reset!',
					action: {
						operation: {
							name: 'reset',
							params: {}
						}
					}
				},
				'runMacro': {
					keys: [ 'c' ],
					keyNames: [ 'c' ],
					label: 'Macro',
					action: {
						macroList: true
					}
				}
			}
		}
	}
};

