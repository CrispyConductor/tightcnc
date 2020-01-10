const blessed = require('blessed');
const { Schema, createSchema } = require('common-schema');
const pasync = require('pasync');
const objtools = require('objtools');

class ListForm {

	constructor(consoleui, options = {}) {
		if (consoleui.screen && !consoleui.setTerminal) {
			this.consoleui = consoleui;
			this.screen = consoleui.screen;
		} else {
			this.consoleui = null;
			this.screen = consoleui;
		}
		this.options = options;
	}

	async showEditor(container, schema, defaultVal, options = {}) {
		if (!container && this.consoleui) {
			return await this.consoleui.runInModal(async (c) => {
				return await this.showEditor(c, schema, defaultVal, options);
			});
		}
		if (!Schema.isSchema(schema)) schema = createSchema(schema);
		let schemaData = schema.getData();
		if (defaultVal === undefined) defaultVal = schemaData.default;
		let val = await this._editValue(container, schemaData, defaultVal, options);
		if (val === null) { // On cancel
			if (options.returnDefaultOnCancel === false) return null;
			// Return default value only if default is valid
			try {
				val = schema.normalize(defaultVal);
			} catch (e) {
				return null;
			}
		}
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
		options = objtools.deepCopy(options);
		options.normalize = (val) => {
			return createSchema(schemaData).normalize(val);
		};
		try {
			if (value === null || value === undefined) value = schemaData.default;
			if (schemaData.editFn) {
				r = await schemaData.editFn(container, schemaData, value, options);
			} else if (schemaData.enum) {
				r = await this._enumSelector(container, schemaData.title || schemaData.label || options.key || 'Select Value', schemaData.enum, value, options);
			} else if (schemaData.type === 'boolean') {
				r = await this.selector(container, schemaData.title || schemaData.label || options.key || 'False or True', [ 'FALSE', 'TRUE' ], value ? 1 : 0, options);
				if (r !== null) r = !!r;
			} else if (schemaData.type === 'object') {
				r = await this._editObject(container, schemaData, value || {}, options);
			} else if (schemaData.type === 'array' && schemaData.isCoordinates) {
				r = await this._editCoordinates(container, schemaData, value || [ 0, 0, 0 ], options);
			} else if (schemaData.type === 'array') {
				r = await this._editArray(container, schemaData, value || [], options);
			} else if (schemaData.type === 'string') {
				r = await this.lineEditor(container, (schemaData.title || schemaData.label || options.key || 'Value') + ':', value, options);
			} else if (schemaData.type === 'number') {
				options.normalize = (r) => {
					if (!r.length || isNaN(r)) {
						throw new Error('Must be valid number');
					} else {
						return parseFloat(r);
					}
				};
				r = await this.lineEditor(container, (schemaData.title || schemaData.label || options.key || 'Value') + ':', value, options);
			} else if (schemaData.type === 'mixed') {
				r = await this._editMixed(container, schemaData, value, options);
			} else if (schemaData.type === 'map') {
				r = await this._editMap(container, schemaData, value || {}, options);
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

	async lineEditor(container, label, defaultValue = '', options = {}) {
		if (defaultValue === null || defaultValue === undefined) defaultValue = '';
		if (typeof defaultValue !== 'string') defaultValue = '' + defaultValue;
		if (this.consoleui) this.consoleui.pushHintOverrides([ [ 'Esc', 'Cancel' ], [ 'Enter', 'Done' ] ]);

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
			if (this.consoleui) this.consoleui.popHintOverrides();
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
			if (options.normalize) {
				try {
					value = options.normalize(value);
				} catch (err) {
					this._message(container, err.message).then(() => textbox.focus());
					return;
				}
			}
			cleanup();
			waiter.resolve(value);
		});

		this.screen.render();
		textbox.setValue(defaultValue);
		this.screen.render();
		return waiter.promise;
	}

	_getEntryDisplayLabel(key, value, schemaData) {
		if (!schemaData) schemaData = {};
		if (value === null || value === undefined) value = schemaData.default;
		if (value === undefined) value = null;
		let keyStr = '' + (schemaData.label || schemaData.description || key);
		if (typeof schemaData.shortDisplayLabel === 'function') {
			value = schemaData.shortDisplayLabel(value, key, schemaData);
		}
		if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
			keyStr += ': ' + value;
		}
		return keyStr;
	}

	async _editCoordinates(container, schemaData, value, options = {}) {
		let coordObj = {};
		let coordObjSchema = {
			type: 'object',
			properties: {}
		};
		let axisLabels = (this.consoleui && this.consoleui.axisLabels) || [ 'x', 'y', 'z' ];
		let usedAxes = (this.consoleui && this.consoleui.usedAxes) || [ true, true, true ];
		let maxNumAxes = Math.min(schemaData.coordinatesLength || 1000, axisLabels.length, usedAxes.length);
		for (let i = 0; i < maxNumAxes; i++) {
			if (usedAxes[i]) {
				let def = value && value[i];
				if (def === null || def === undefined) def = (schemaData.default && schemaData.default[i]) || 0;
				coordObj[axisLabels[i].toUpperCase()] = def;
				coordObjSchema.properties[axisLabels[i].toUpperCase()] = { type: 'number' };
			}
		}

		let extraKeys = [];
		if (this.consoleui) {
			extraKeys.push({
				hint: [ 'c', 'Use Current Pos' ],
				keys: [ 'c' ],
				fn: ({data}) => {
					let pos = [ 111, 222, 333 ];
					for (let i = 0; i < maxNumAxes && i < pos.length; i++) {
						if (usedAxes[i]) {
							let v = pos[i];
							if (typeof v === 'number') {
								data[axisLabels[i].toUpperCase()] = v;
							}
						}
					}
				}
			});
		}

		let r = await this._editObject(container, coordObjSchema, coordObj, { extraKeys });
		if (r === null) return null;
		let newValue = [];
		for (let i = 0; i < maxNumAxes; i++) {
			let v = r[axisLabels[i].toUpperCase()] || 0;
			newValue.push(v);
		}
		return newValue;
	}

	async _editMixed(container, schemaData, value = null, options = {}) {
		// Show type selector
		let currentTypeNum;
		if (typeof value === 'string') {
			currentTypeNum = 0;
		} else if (typeof value === 'boolean') {
			currentTypeNum = 1;
		} else if (typeof value === 'number') {
			currentTypeNum = 2;
		} else if (Array.isArray(value)) {
			currentTypeNum = 3;
		} else if (value && typeof value === 'object') {
			currentTypeNum = 4;
		} else {
			value = null;
			currentTypeNum = null;
		}
		const typeLabelList = [ 'String', 'True/False', 'Number', 'List', 'Table (Object/Dict)' ];
		let currentType = (currentTypeNum === null) ? null : typeLabelList[currentTypeNum];
		let selectedTypeNum = await this.selector(
			container,
			'Edit As:' + (currentType ? (' (Currently ' + currentType + ')') : ''),
			typeLabelList,
			currentTypeNum || 0
		);
		if (selectedTypeNum === null) {
			if (options.returnDefaultOnCancel === false) return null;
			return value;
		}

		// If changing type, reset value
		if (selectedTypeNum === 0 && typeof value !== 'string') value = '';
		if (selectedTypeNum === 1 && typeof value !== 'boolean') value = false;
		if (selectedTypeNum === 2 && typeof value !== 'number') value = 0;
		if (selectedTypeNum === 3 && !Array.isArray(value)) value = [];
		if (selectedTypeNum === 4 && (!value || typeof value !== 'object')) value = {};

		// Make the subschema for the next type
		let stSchema = null;
		if (selectedTypeNum === 0) stSchema = { type: 'string', default: value };
		if (selectedTypeNum === 1) stSchema = { type: 'boolean', default: value };
		if (selectedTypeNum === 2) stSchema = { type: 'number', default: value };
		if (selectedTypeNum === 3) stSchema = { type: 'array', elements: { type: 'mixed' }, default: value };
		if (selectedTypeNum === 4) stSchema = { type: 'map', values: { type: 'mixed' }, default: value };

		// Show an editor for each type
		let newValue = await this._editValue(container, stSchema, value, {});
		return newValue;
	}

	async _editArray(container, schemaData, value = [], options = {}) {
		if (!value) value = [];
		let elementsSchema = schemaData.elements;
		value = objtools.deepCopy(value || []);
		let title = schemaData.title || schemaData.label || options.key || 'Edit Properties';
		let elementLabels = value.map((el, idx) => this._getEntryDisplayLabel(idx, el, elementsSchema));
		elementLabels.push(schemaData.doneLabel || '[Done]');
		options = objtools.deepCopy(options);
		options.keys = [
			{
				hint: [ '+',  'Add' ],
				keys: [ '+', '=' ],
				fn: ({ listBox, selected }) => {
					if (selected > value.length) return;
					value.splice(selected, 0, elementsSchema.default);
					listBox.insertItem(selected, '');
					for (let i = selected; i < value.length; i++) {
						listBox.setItem(i, this._getEntryDisplayLabel(i, value[i], elementsSchema));
					}
					this.screen.render();
				}
			},
			{
				hint: [ 'Del',  'Remove' ],
				keys: [ 'delete' ],
				fn: ({ listBox, selected }) => {
					if (selected >= value.length) return;
					value.splice(selected, 1);
					listBox.removeItem(selected);
					for (let i = selected; i < value.length; i++) {
						listBox.setItem(i, this._getEntryDisplayLabel(i, value[i], elementsSchema));
					}
					this.screen.render();
				}
			}
		];
		let r = await this.selector(container, title, elementLabels, 0, options, async (selected, listBox) => {
			if (selected >= value.length) {
				if (options.normalize) {
					try {
						value = options.normalize(value);
					} catch (err) {
						this._message(container, err.message);
						return true;
					}
				}
				return false;
			}

			let elementValue = value[selected];
			if (elementValue === null || elementValue === undefined) elementValue = elementsSchema.default;
			let opts = objtools.deepCopy(schemaData.formOptions || {});
			opts.key = selected;
			if (elementsSchema.actionFn) {
				try {
					await elementsSchema.actionFn({
						selectedIndex: selected,
						selectedKey: selected,
						selectedCurValue: elementValue,
						opts,
						listBox,
						array: value
					});
				} catch (err) {
					await this._message(container, err.message);
				}
				for (let i = 0; i < value.length; i++) {
					listBox.setItem(i, this._getEntryDisplayLabel(i, value[i], elementsSchema));
				}
				this.screen.render();
				return true;
			} else {
				let newValue = await this._editValue(container, elementsSchema, elementValue, opts);
				if (newValue !== null) {
					value[selected] = newValue;
					listBox.setItem(selected, this._getEntryDisplayLabel(selected, value[selected], elementsSchema));
				}
				this.screen.render();
				return true;
			}
		});
		if (r === null) {
			if (options.returnDefaultOnCancel === false) return null;
			// NOTE: Hitting Esc while editing an object still counts as editing the object if fields
			// have been modified, unless the object fails validation
			if (options.normalize) {
				try {
					value = options.normalize(value);
				} catch (e) {
					return null;
				}
			}
		}
		return value;
	}

	async _editMap(container, schemaData, value = {}, options = {}) {
		value = objtools.deepCopy(value);
		let title = schemaData.title || schemaData.label || options.key || 'Edit Mapping';

		let mapKeys = Object.keys(value); // used to ensure consistent ordering
		let keyStrs = mapKeys.map((k) => {
			return this._getEntryDisplayLabel(k, value[k]);
		});
		keyStrs.push(schemaData.doneLabel || '[Done]');

		options = objtools.deepCopy(options);
		options.keys = [
			{
				hint: [ '+',  'Add Key' ],
				keys: [ '+', '=' ],
				fn: ({ listBox, selected }) => {
					this.lineEditor(container, 'New Key', '')
						.then((key) => {
							if (!key) return;
							if (key in value) {
								this._message(container, 'Key already exists');
								return;
							}
							mapKeys.push(key);
							value[key] = (schemaData.values.default === undefined) ? null : schemaData.values.default;
							listBox.insertItem(mapKeys.length - 1, this._getEntryDisplayLabel(key, value[key], schemaData.values));
							this.screen.render();
						})
						.catch((err) => {
							this._message(container, '' + err);
						});
				}
			},
			{
				hint: [ 'Del',  'Remove' ],
				keys: [ 'delete' ],
				fn: ({ listBox, selected }) => {
					if (selected >= mapKeys.length) return;
					let removedKey = mapKeys[selected];
					mapKeys.splice(selected, 1);
					delete value[removedKey];
					listBox.removeItem(selected);
					this.screen.render();
				}
			}
		];

		let r = await this.selector(container, title, keyStrs, 0, options, async (selected, listBox) => {
			if (selected === mapKeys.length) {
				if (options.normalize) {
					try {
						value = options.normalize(value);
					} catch (err) {
						this._message(container, err.message);
						return true;
					}
				}
				return false;
			}
			let key = mapKeys[selected];
			let curValue = value[key];
			if (curValue === null || curValue === undefined) curValue = schemaData.values.default;
			let opts = objtools.deepCopy(schemaData.formOptions || {});
			opts.key = key;
			if (schemaData.values.actionFn) {
				try {
					await schemaData.values.actionFn({
						selectedIndex: selected,
						selectedKey: key,
						selectedCurValue: curValue,
						opts,
						listBox,
						obj: value
					});
				} catch (err) {
					await this._message(container, err.message);
				}
				for (let i = 0; i < mapKeys.length; i++) {
					listBox.setItem(i, this._getEntryDisplayLabel(mapKeys[i], value[mapKeys[i]]));
				}
				this.screen.render();
				return true;
			} else {
				let newValue = await this._editValue(container, schemaData.values, curValue, opts);
				if (newValue !== null) {
					value[key] = newValue;
					listBox.setItem(selected, this._getEntryDisplayLabel(key, newValue));
				}
				this.screen.render();
				return true;
			}
		});
		if (r === null) {
			if (options.returnDefaultOnCancel === false) return null;
			if (options.normalize) {
				try {
					value = options.normalize(value);
				} catch (e) {
					return null;
				}
			}
		}
		return value;
	}

	async _editObject(container, schemaData, value = {}, options = {}) {
		value = objtools.deepCopy(value);
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

		keyStrs.push(schemaData.doneLabel || '[Done]');

		let totalNumItems = keyStrs.length;

		options = objtools.deepCopy(options);
		if (!options.keys) options.keys = [];
		const addExtraKey = (k) => {
			let origFn = k.fn;
			k.fn = (info) => {
				info.data = value;
				origFn(info);
				for (let i = 0; i < keysByIndex.length; i++) {
					info.listBox.setItem(i, getEntryLabel(keysByIndex[i], value[keysByIndex[i]]));
				}
				this.screen.render();
			};
			options.keys.push(k);
		};
		if (options.extraKeys) {
			for (let k of options.extraKeys) {
				addExtraKey(k);
			}
		}

		let r = await this.selector(container, title, keyStrs, 0, options, async (selected, listBox) => {
			if (selected === totalNumItems - 1) {
				if (options.normalize) {
					try {
						value = options.normalize(value);
					} catch (err) {
						this._message(container, err.message);
						return true;
					}
				}
				return false;
			}
			let key = keysByIndex[selected];
			let curValue = value[key];
			if (curValue === null || curValue === undefined) curValue = schemaData.properties[key].default;
			let opts = objtools.deepCopy(schemaData.formOptions || {});
			opts.key = key;
			if (schemaData.properties[key].actionFn) {
				try {
					await schemaData.properties[key].actionFn({
						selectedIndex: selected,
						selectedKey: key,
						selectedCurValue: curValue,
						opts,
						listBox,
						obj: value
					});
				} catch (err) {
					await this._message(container, err.message);
				}
				for (let i = 0; i < keysByIndex.length; i++) {
					listBox.setItem(i, getEntryLabel(keysByIndex[i], value[keysByIndex[i]]));
				}
				this.screen.render();
				return true;
			} else {
				let newValue = await this._editValue(container, schemaData.properties[key], curValue, opts);
				if (newValue !== null) {
					value[key] = newValue;
					listBox.setItem(selected, getEntryLabel(key, newValue));
				}
				this.screen.render();
				return true;
			}
		});
		if (r === null) {
			if (options.returnDefaultOnCancel === false) return null;
			// NOTE: Hitting Esc while editing an object still counts as editing the object if fields
			// have been modified, unless the object fails validation
			if (options.normalize) {
				try {
					value = options.normalize(value);
				} catch (e) {
					return null;
				}
			}
		}
		return value;
	}

	async _enumSelector(container, title, values, defaultValue, options = {}) {
		let strValues = values.map((v) => '' + v);
		let defaultIdx = (defaultValue === undefined) ? 0 : values.indexOf(defaultValue);
		if (defaultIdx === -1) defaultIdx = 0;
		let selectedIdx = await this.selector(container, title, strValues, defaultIdx, options);
		if (selectedIdx === null || selectedIdx === undefined) return null;
		return values[selectedIdx];
	}

	selector(container, title, items, defaultSelected = 0, options = {}, handler = null) {
		if (!container && this.consoleui) {
			return this.consoleui.runInModal(async (c) => {
				return await this.selector(c, title, items, defaultSelected, options, handler);
			});
		}

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

		if (this.consoleui) {
			let hints = [ [ 'Esc', 'Cancel' ], [ 'Up/Down', 'Select' ], [ 'Enter', 'Done' ] ];
			if (options.keys) {
				for (let el of options.keys) {
					if (el.hint) hints.push(el.hint);
				}
			}
			this.consoleui.pushHintOverrides(hints);
		}

		let waiter = pasync.waiter();

		// Need to support 2 modes:
		// Either select a single option then resolve, or allow repeated calls to a handler, and exit on handler return false or cancel (escape)

		const cleanup = () => {
			if (this.consoleui) this.consoleui.popHintOverrides();
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

		// Custom keys
		if (options.keys) {
			for (let el of options.keys) {
				if (el.keys && el.fn) {
					listBox.key(el.keys, () => {
						el.fn({
							container,
							listBox,
							selected: listBox.selected
						});
					});
				}
			}
		}

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

let schema = {
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
		},
		artest: { type: 'array', elements: Number, default: [ 1, 2, 3 ] },
		maptest: {
			type: 'map',
			values: String,
			default: { foo: 'bar', biz: 'baz' }
		},
		mixed: {
			type: 'mixed'
		},
		coor: {
			type: [ Number ],
			isCoordinates: true,
			default: [ 1, 2, 3 ]
		}
	}
};

let lf = new ListForm(screen);

lf.showEditor(screen, schema)
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

