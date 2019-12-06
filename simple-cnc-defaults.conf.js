module.exports = {
	authKey: 'abc123',
	serverPort: 2363,
	host: 'http://localhost',
	controller: 'TinyG',
	controllers: {
		TinyG: {
			port: '/dev/ttyUSB0',
			baudRate: 115200,
			dataBits: 8,
			stopBits: 1,
			parity: 'none',
			rtscts: false,
			xany: true
		}
	},
	operations: {
	},
	consoleui: {
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
				}
			}
		}
	}
};

