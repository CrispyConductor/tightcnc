const blessed = require('blessed');
const { Schema, createSchema } = require('common-schema');
const pasync = require('pasync');
const objtools = require('objtools');

class ListForm {

	constructor(screen, schema, options = {}) {
		this.screen = screen;
		this.options = options;
		if (!Schema.isSchema(schema)) schema = createSchema(schema);
		this.schema = schema;
	}

	async showEditor(container, defaultVal) {
		let schemaData = this.schema.getData();
		if (defaultVal === undefined) defaultVal = schemaData.default;
		let val = await this._editValue(container, schemaData, defaultVal);
		return val;
	}

	async _message(container, message, time = 2000) {
		let messageBox = blessed.box({
			border: {
				type: 'line'
			},
			content: message,
			align: 'center',
			valign: 'middle',
			width: message.length + 2,
			height: 3,
			top: 'center',
			left: 'center'
		});
		container.append(messageBox);
		this.screen.lockKeys = true;
		this.screen.render();
		await pasync.setTimeout(time);
		container.remove(messageBox);
		this.screen.lockKeys = false;
		this.screen.render();
	}

	async _editValue(container, schemaData, value, options = {}) {
		let r;
		try {
			if (schemaData.editFn) {
				r = await schemaData.editFn(container, schemaData, value, options);
			} else if (schemaData.enum) {
				r = await this._enumSelector(container, schemaData.title || schemaData.label || options.key || 'Select Value', schemaData.enum, value || schemaData.default, options);
			} else if (schemaData.type === 'boolean') {
				r = await this._selector(container, schemaData.title || schemaData.label || options.key || 'False or True', [ 'FALSE', 'TRUE' ], schemaData.default ? 1 : 0, options);
				if (r !== null) r = !!r;
			} else if (schemaData.type === 'object') {
				r = await this._editObject(container, schemaData, value || schemaData.default || {}, options);
			} else if (schemaData.type === 'string') {
				r = await this._lineEditor(container, (schemaData.title || schemaData.label || options.key || 'Value') + ':', value, options);
			} else if (schemaData.type === 'number') {
				r = await this._lineEditor(container, (schemaData.title || schemaData.label || options.key || 'Value') + ':', value, options);
				if (r !== null) {
					if (!r.length || isNaN(r)) {
						throw new Error('Must be valid number');
					} else {
						r = parseFloat(r);
					}
				}
			} else {
				throw new Error('Unsupported edit schema type');
			}
			//if (r === null) r = value;
			if (r === null) return null;
			r = createSchema(schemaData).normalize(r);
		} catch (err) {
			//this.screen.destroy();
			//console.log(err, err.stack);
			//process.exit(1);
			await this._message(container, err.message);
			return await this._editValue(container, schemaData, value, options);
		}
		return r;
	}

	async _lineEditor(container, label, defaultValue = '', options = {}) {
		if (defaultValue === null || defaultValue === undefined) defaultValue = '';
		if (typeof defaultValue !== 'string') defaultValue = '' + defaultValue;

		let outerBorder = blessed.box({
			width: options.width || '80%',
			height: 5,
			top: options.top || 'center',
			left: options.left || '10%',
			border: { type: 'line' }
		});

		let labelBox = blessed.box({
			width: label.length,
			height: 1,
			align: 'center',
			content: label,
			top: 1,
			left: 0
		});
		outerBorder.append(labelBox);

		let innerBorder = blessed.box({
			width: '100%-' + (label.length + 2),
			height: 3,
			top: 0,
			left: label.length,
			border: { type: 'line' }
		});
		outerBorder.append(innerBorder);

		let textbox = blessed.textbox({
			inputOnFocus: true,
			height: 1,
			width: '100%-2'
		});
		innerBorder.append(textbox);

		container.append(outerBorder);
		textbox.focus();

		const cleanup = () => {
			innerBorder.remove(textbox);
			outerBorder.remove(innerBorder);
			container.remove(outerBorder);
			this.screen.render();
		};

		let waiter = pasync.waiter();

		textbox.on('cancel', () => {
			cleanup();
			waiter.resolve(null);
		});

		textbox.on('submit', () => {
			let value = textbox.getValue();
			cleanup();
			waiter.resolve(value);
		});

		this.screen.render();
		textbox.setValue(defaultValue);
		this.screen.render();
		return waiter.promise;
	}

	_getEntryDisplayLabel(key, value, schemaData) {
		if (value === null || value === undefined) value = schemaData.default;
		if (value === undefined) value = null;
		let keyStr = '' + (schemaData.label || schemaData.description || key);
		if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
			keyStr += ' - ' + value;
		}
		return keyStr;
	}

	async _editObject(container, schemaData, value = {}, options = {}) {
		let keysByIndex = [];
		let keyNames = [];
		let keyStrs = [];
		const getEntryLabel = (key, value) => {
			return this._getEntryDisplayLabel(key, value, schemaData.properties[key]);
		};
		for (let key in schemaData.properties) {
			keysByIndex.push(key);
			keyStrs.push(getEntryLabel(key, value[key]));
		}
		let title = schemaData.title || schemaData.label || options.key || 'Edit Properties';

		keyStrs.push('[Done]');

		let totalNumItems = keyStrs.length;

		let r = await this._selector(container, title, keyStrs, 0, options, async (selected, listBox) => {
			if (selected === totalNumItems - 1) {
				return false;
			}
			let key = keysByIndex[selected];
			let curValue = value[key];
			if (curValue === null || curValue === undefined) curValue = schemaData.properties[key].default;
			let opts = objtools.deepCopy(schemaData.formOptions || {});
			opts.key = key;
			let newValue = await this._editValue(container, schemaData.properties[key], curValue, opts);
			if (newValue !== null) {
				value[key] = newValue;
				listBox.setItem(selected, getEntryLabel(key, newValue));
			}
			this.screen.render();
			return true;
		});
		if (r === null) return r;
		return value;
	}

	async _enumSelector(container, title, values, defaultValue, options = {}) {
		let strValues = values.map((v) => '' + v);
		let defaultIdx = (defaultValue === undefined) ? 0 : values.indexOf(defaultValue);
		if (defaultIdx === -1) defaultIdx = 0;
		let selectedIdx = await this._selector(container, title, strValues, defaultIdx, options);
		if (selectedIdx === null || selectedIdx === undefined) return null;
		return values[selectedIdx];
	}

	_selector(container, title, items, defaultSelected = 0, options = {}, handler = null) {
		// Container box
		let listContainer = blessed.box({
			width: options.width || '100%',
			height: options.height || '100%',
			top: options.top || 0,
			left: options.left || 0,
			border: { type: 'line' }
		});

		// Title line
		let titleBox = blessed.box({
			width: '100%',
			height: 1,
			align: 'center',
			content: title
		});
		listContainer.append(titleBox);

		// List to select options
		let listBox = blessed.list({
			style: options.style || {
				selected: {
					inverse: true
				},
				item: {
					inverse: false
				}
			},
			keys: true,
			items: items,
			width: '100%-2',
			height: '100%-3',
			top: 1,
			border: { type: 'line' }
		});
		listBox.selected = defaultSelected;
		listContainer.append(listBox);

		container.append(listContainer);
		listBox.focus();

		let waiter = pasync.waiter();

		// Need to support 2 modes:
		// Either select a single option then resolve, or allow repeated calls to a handler, and exit on handler return false or cancel (escape)

		const cleanup = () => {
			listContainer.remove(listBox);
			container.remove(listContainer);
			this.screen.render();
		};

		listBox.on('select', () => {
			let selected = listBox.selected;
			if (handler) {
				try {
					let r = handler(selected, listBox);
					if (r === false) {
						cleanup();
						waiter.resolve(selected);
					} else if (r && typeof r.then === 'function') {
						r
							.then((r) => {
								if (r === false) {
									cleanup();
									waiter.resolve(listBox.selected);
								} else {
									listBox.focus();
								}
							})
							.catch((err) => {
								cleanup();
								waiter.reject(err);
							});
					} else {
						listContainer.focus();
					}
				} catch (err) {
					cleanup();
					waiter.reject(err);
				}
			} else {
				cleanup();
				waiter.resolve(selected);
			}
		});
		listBox.once('cancel', () => {
			cleanup();
			waiter.resolve(null);
		});

		this.screen.render();

		return waiter.promise;
	}

	_makeFormEl(schemaData, values, options = {}) {
		if (schemaData.type !== 'object') throw new Error('Must be object');

		// Container box for this form
		let listContainer = blessed.box({
			width: options.width,
			height: options.height,
			top: options.top,
			left: options.left,
			border: { type: 'line' }
		});

		// Title line
		if (!title) title = schema.title || schema.description || 'Select Option';
		let titleBox = blessed.box({
			width: '100%',
			height: 1,
			align: 'center',
			content: title
		});
		listContainer.append(titleBox);

		// Determine the set of list items (stuff from schema, plus Done button)
		// Each item can be read only (determined by readOnly flag on schema).  Types are each handled differently.
		// If a schema entry contains an 'action' property, that function is run instead of editing
		let listEntryStrings = [];
		let listEntryActions = [];
		const addListEntry = (str, subschema, action) => {
		};


		// List to select options
		let listBox = blessed.list({
			style: options.style || {
				selected: {
					inverse: true
				},
				item: {
					inverse: false
				}
			},
			keys: true,
			items: listEntryStrings,
			width: '100%-2',
			height: '100%-3',
			top: 1,
			border: { type: 'line' }
		});
	}

}

module.exports = ListForm;


/*
var screen = blessed.screen({
	smartCSR: true
});

let lf = new ListForm(screen, {
	type: 'object',
	label: 'Edit my object',
	properties: {
		strtest: {
			type: 'string',
			default: 'bar',
			label: 'Test String',
			validate(val) {
				if (val === 'foo') throw new Error('Val cant be foo');
			}
		},
		btest: {
			type: 'boolean',
			label: 'Test Boolean'
		},
		entest: {
			type: 'string',
			default: 'ZAP',
			label: 'Test Enum',
			enum: [ 'ZIP', 'ZAP', 'ZOOP' ]
		},
		ntest: {
			type: 'number',
			default: 3
		},
		subobj: {
			prop1: String,
			prop2: Number
		}
	}
});

lf.showEditor(screen)
	.then((r) => {
		screen.destroy();
		console.log('Result', r);
		process.exit(0);
	}, (err) => {
		screen.destroy();
		console.error('Error', err);
		process.exit(1);
	});
*/

