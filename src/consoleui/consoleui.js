const blessed = require('blessed');
const SimpleCNCClient = require('../../lib/clientlib');

class ConsoleUI {

	constructor() {
		this.statusBoxes = [];
		this.hints = [];
		this.config = require('littleconf').getConfig();
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
			if (hint.length > widthPerHint) hint = hint.slice(0, widthPerHint - 2);
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
			height: '100%-2'
		});
		this.screen.append(this.mainOuterBox);

		let hintSeparatorLine = blessed.line({
			type: 'line',
			orientation: 'horizontal',
			width: '100%',
			bottom: 1
		});
		this.screen.append(hintSeparatorLine);

		this.bottomHintBox = blessed.box({
			tags: true,
			bottom: 0,
			height: 1,
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

		this.screen.key([ 'escape', 'q', 'C-c' ], function(ch, key) {
			process.exit(0);
		});

		this.screen.on('resize', () => {
			this.updateHintBox();
		});

		this.screen.render();

		this.addHints([ ['q', 'Quit'] ]);
	}

	async initClient() {
		console.log('Connecting ...');
		this.client = new SimpleCNCClient(this.config);
		await this.client.op('getStatus');
	}

	async run() {
		await this.initClient();

		this.initUI();
		this.addStatusBox('Foo Title', { 'a': 1, 'b': 2, 'c': 3 });

		this.addStatusBox('Foo2 Title', { 'a': 1, 'b': 2, 'c': 3 });
		this.addHints(['q=quit', 'a=a', 'b=b', 'c=c']);
	}

}


new ConsoleUI().run().catch((err) => console.error(err, err.stack));

