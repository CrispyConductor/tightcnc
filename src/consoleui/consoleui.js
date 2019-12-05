const blessed = require('blessed');
const SimpleCNCClient = require('../../lib/clientlib');
const pasync = require('pasync');

class ConsoleUI {

	constructor() {
		this.statusBoxes = [];
		this.hints = [];
		this.config = require('littleconf').getConfig();
		this.hintBoxHeight = 2;
	}

	addHints(hints) {
		for (let i = 0; i < hints.length; i++) {
			if (Array.isArray(hints[i])) {
				hints[i] = '{inverse}' + hints[i][0] + '{/inverse} ' + hints[i][1];
			}
		}
		this.hints.push(...hints);
		this.updateHintBox();
	}

	removeHints(hints) {
		this.hints = this.hints.filter((h) => hints.indexOf(h) === -1);
		this.updateHintBox();
	}

	updateHintBox() {
		if (!this.hints.length) {
			this.bottomHintBox.setContent('');
			return;
		}
		let totalWidth = this.bottomHintBox.width;
		let widthPerHint = totalWidth / this.hints.length;
		let content = '';
		for (let hint of this.hints) {
			//if (hint.length > widthPerHint) hint = hint.slice(0, widthPerHint - 2); // this breaks with tags
			let padLeft = Math.floor((widthPerHint - hint.length) / 2);
			let padRight = Math.ceil((widthPerHint - hint.length) / 2);
			for (let i = 0; i < padLeft; i++) content += ' ';
			content += hint;
			for (let i = 0; i < padRight; i++) content += ' ';
		}

		this.bottomHintBox.setContent('{center}' + content + '{/center}');
		this.screen.render();
	}

	/**
	 * Adds a status box to the status box stack.
	 *
	 * @method addStatusBox
	 * @param {String} title - Status box title
	 * @param {Object} statusObj - An object mapping keys to status values to display.
	 * @param {Object} labels - Optional mapping from status keys to display labels for them.
	 * @return {Object} - A reference to the UI data for the box.
	 */
	addStatusBox(title, statusObj, labels = null) {
		if (!labels) {
			labels = {};
			for (let key in statusObj) labels[key] = key;
		}
		let boxData = {
			title: title,
			data: statusObj,
			labels: labels,
			titleBox: blessed.box({
				tags: true,
				width: '100%',
				height: 1,
				content: '{center}{bold}' + title + '{/bold}{/center}'
			}),
			box: blessed.box({
				tags: true,
				width: '100%',
				content: ''
			}),
			line: blessed.line({
				type: 'line',
				orientation: 'horizontal',
				width: '100%'
			})
		};
		this.statusBoxes.push(boxData);
		this.statusPane.append(boxData.titleBox);
		this.statusPane.append(boxData.box);
		this.statusPane.append(boxData.line);
		this.updateStatusBoxes();
		return boxData;
	}

	removeStatusBox(boxData) {
		let boxIdx = this.statusBoxes.indexOf(boxData);
		if (boxIdx === -1) {
			for (let i = 0; i < this.statusBoxes.length; i++) {
				if (this.statusBoxes[i].data === boxData) {
					boxIdx = i;
					boxData = this.statusBoxes[i];
					break;
				}
			}
			if (boxIdx === -1) return;
		}
		this.statusPane.remove(boxData.titleBox);
		this.statusPane.remove(boxData.box);
		this.statusPane.remove(boxData.line);
		this.statusBoxes.splice(boxIdx, 1);
		this.updateStatusBoxes();
	}

	updateStatusBoxes() {
		let vOffset = 0;
		for (let boxData of this.statusBoxes) {
			let numEntries = Object.keys(boxData.labels).length;
			boxData.box.position.height = numEntries;
			boxData.titleBox.position.top = vOffset;
			boxData.box.position.top = vOffset + 1;
			boxData.line.position.top = vOffset + 1 + numEntries;
			vOffset += numEntries + 2;
			let content = '';
			for (let key in boxData.labels) {
				if (content) content += '\n';
				let dataStr = boxData.data[key];
				if (dataStr === null || dataStr === undefined) dataStr = '';
				dataStr = '' + dataStr;
				content += boxData.labels[key] + ':{|}' + dataStr;
			}
			boxData.box.setContent(content);
		}
		this.screen.render();
	}

	initUI() {
		this.screen = blessed.screen({
			smartCSR: true
		});
		this.screen.title = 'SimpleCNC Console UI';

		this.mainOuterBox = blessed.box({
			top: 0,
			height: '100%-' + (3 + this.hintBoxHeight)
		});
		this.screen.append(this.mainOuterBox);

		let messageSeparatorLine = blessed.line({
			type: 'line',
			orientation: 'horizontal',
			width: '100%',
			bottom: this.hintBoxHeight + 2
		});
		this.screen.append(messageSeparatorLine);

		this.messageBox = blessed.box({
			tags: true,
			bottom: this.hintBoxHeight + 1,
			width: '100%',
			height: 1,
			content: '',
			align: 'center'
		});
		this.screen.append(this.messageBox);

		let hintSeparatorLine = blessed.line({
			type: 'line',
			orientation: 'horizontal',
			width: '100%',
			bottom: this.hintBoxHeight
		});
		this.screen.append(hintSeparatorLine);

		this.bottomHintBox = blessed.box({
			tags: true,
			bottom: 0,
			height: this.hintBoxHeight,
			content: ''
		});
		this.screen.append(this.bottomHintBox);

		this.statusPane = blessed.box({
			left: 0,
			width: '20%',
			content: 'Status'
		});
		this.mainOuterBox.append(this.statusPane);

		let statusSeparatorLine = blessed.line({
			type: 'line',
			orientation: 'vertical',
			left: '20%',
			height: '100%'
		});
		this.mainOuterBox.append(statusSeparatorLine);

		this.mainPane = blessed.box({
			right: 0,
			width: '80%-1'
		});
		this.mainOuterBox.append(this.mainPane);

		this.screen.key([ 'escape', 'C-c' ], function(ch, key) {
			process.exit(0);
		});

		this.screen.on('resize', () => {
			this.updateHintBox();
		});

		this.screen.render();

		this.addHints([ ['Esc', 'Quit'] ]);
	}

	async initClient() {
		console.log('Connecting ...');
		this.client = new SimpleCNCClient(this.config);
		return await this.client.op('getStatus');
	}

	setupPrimaryStatusBoxes() {
		this.machineStateStatusBox = this.addStatusBox('Machine', { state: 'NOT READY', paused: null, error: null }, { state: 'State', paused: 'Pause', error: 'Err' });
		let posStatusInitial = {};
		let posStatusLabels = {};
		for (let i = 0; i < this.usedAxes.length; i++) {
			if (this.usedAxes[i]) {
				posStatusInitial[this.axisLabels[i]] = null;
				posStatusLabels[this.axisLabels[i]] = this.axisLabels[i].toUpperCase();
			}
		}
		this.positionStatusBox = this.addStatusBox('Pos Cur/Mach', posStatusInitial, posStatusLabels);
		this.miscStateStatusBox = this.addStatusBox('State', {
			activeCoordSys: null,
			allAxisHomed: null,
			units: null,
			feed: null,
			incremental: null,
			moving: null,
			spindle: null,
			coolant: null
		}, {
			moving: 'Moving',
			activeCoordSys: 'Coord',
			incremental: 'Inc',
			spindle: 'Spind',
			coolant: 'Cool',
			feed: 'Feed',
			units: 'Unit',
			allAxisHomed: 'Homed'
		});
	}

	updatePrimaryStatusBoxes(status) {
		// Machine state
		let machineState = null;
		let machineError = null;
		if (status.error) {
			machineState = '{red-bg}ERROR{/red-bg}';
			machineError = JSON.stringify(status.errorData);
		} else if (status.ready) {
			machineState = '{green-bg}READY{/green-bg}';
		} else {
			machineState = '{red-bg}NOT READY{/red-bg}';
		}
		this.machineStateStatusBox.data.state = machineState;
		this.machineStateStatusBox.data.error = machineError;
		this.machineStateStatusBox.data.paused = status.paused ? '{red-bg}YES{/red-bg}' : 'NO';

		// Position
		const posPrecision = 3;
		for (let i = 0; i < this.usedAxes.length; i++) {
			if (this.usedAxes[i]) {
				let axis = this.axisLabels[i];
				let posStr = '';
				if (status.pos && typeof status.pos[i] === 'number') {
					posStr += status.pos[i].toFixed(posPrecision);
				}
				if (status.mpos && typeof status.mpos[i] === 'number') {
					posStr += '{gray-fg}/' + status.mpos[i].toFixed(posPrecision) + '{/gray-fg}';
				}
				this.positionStatusBox.data[axis] = posStr;
			}
		}

		// Misc
		this.miscStateStatusBox.data.activeCoordSys = (typeof status.activeCoordSys === 'number') ? ('G' + (status.activeCoordSys + 54)) : '';
		if (status.homed) {
			this.miscStateStatusBox.data.allAxisHomed = '{green-fg}YES{/green-fg}';
			for (let i = 0; i < this.usedAxes.length; i++) {
				if (this.usedAxes[i] && !status.homed[i]) {
					this.miscStateStatusBox.data.allAxisHomed = 'NO';
				}
			}
		} else {
			this.miscStateStatusBox.data.allAxisHomed = '';
		}
		this.miscStateStatusBox.data.units = status.units;
		this.miscStateStatusBox.data.feed = (typeof status.feed === 'number') ? status.feed.toFixed(posPrecision) : '';
		const boolstr = (val, iftrue = '{yellow-fg}YES{/yellow-fg}', iffalse = 'NO') => {
			if (val) return iftrue;
			if (val === null || val === undefined || val === '') return '';
			return iffalse;
		};
		this.miscStateStatusBox.data.incremental = boolstr(status.incremental);
		this.miscStateStatusBox.data.moving = boolstr(status.moving);
		let spindleStr = '';
		if (status.spindle === true && status.spindleDirection === 1) {
			spindleStr = '{yellow-fg}FWD{/yellow-fg}';
		} else if (status.spindle === true && status.spindleDirection === -1) {
			spindleStr = '{yellow-fg}REV{/yellow-fg}';
		} else if (status.spindle === true) {
			spindleStr = '{yellow-fg}ON{/yellow-fg}';
		} else if (status.spindle === false) {
			spindleStr = 'OFF';
		}
		this.miscStateStatusBox.data.spindle = spindleStr;
		this.miscStateStatusBox.data.coolant = boolstr(status.coolant, '{yellow-fg}ON{/yellow-fg}', 'OFF');

		this.updateStatusBoxes();
	}

	setMessage(msg) {
		this.messageBox.setContent(msg);
		this.screen.render();
	}

	showTempMessage(msg, time = 6) {
		this.setMessage(msg);
		if (this.curTempMessageTimeout) clearTimeout(this.curTempMessageTimeout);
		this.curTempMessageTimeout = setTimeout(() => {
			delete this.curTempMessageTimeout;
			this.setMessage('');
		}, time * 1000);
	}

	clientError(err) {
		this.showTempMessage(err.message || ('' + err));
	}

	runStatusUpdateLoop() {
		const updateInterval = 500;
		const runLoop = async() => {
			while (true) {
				await pasync.setTimeout(updateInterval);
				let status;
				try {
					status = await this.client.op('getStatus');
				} catch (err) {
					this.clientError(err);
				}
				this.updatePrimaryStatusBoxes(status);
			}
		};
		runLoop().catch(this.clientError.bind(this));
	}

	async run() {
		let initStatus = await this.initClient();
		this.axisLabels = initStatus.axisLabels;
		this.usedAxes = initStatus.usedAxes;

		this.initUI();
		this.setupPrimaryStatusBoxes();
		this.updatePrimaryStatusBoxes(initStatus);
		this.runStatusUpdateLoop();

		this.addHints(['q=quit', 'a=a', 'b=b', 'c=c']);
	}

}


new ConsoleUI().run().catch((err) => console.error(err, err.stack));

