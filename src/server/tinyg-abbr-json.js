/**
 * This file contains functions for generating and parsing the TinyG abbreviated JSON.  The two exported functions, parse and stringify,
 * mirror the normal JSON implementations, but don't support the extra options.  stringify() here does support a second parameter, which
 * is the precision (number of decimal digits) to use for numbers (default 5).
 */

const cc0 = '0'.charCodeAt(0);
const cc9 = '9'.charCodeAt(0);
const cca = 'a'.charCodeAt(0);
const ccz = 'z'.charCodeAt(0);
const ccA = 'A'.charCodeAt(0);
const ccZ = 'Z'.charCodeAt(0);

const strEscapes = {
	'r': '\r',
	'n': '\n',
	't': '\t',
	'"': '"',
	'\\': '\\'
};

let idx;
let str;
let l;

function skipWhitespace() {
	while (idx < l && (str[idx] === ' ' || str[idx] === '\t' || str[idx] === '\r' || str[idx] === '\n')) {
		idx++;
	}
	return idx;
}

function parseString() {
	// Skip past the " that has already been parsed
	idx++;
	if (idx >= l) throw new Error('TinyG JSON Parse Error: Unexpected end of input');
	// Parse one character at a time, stopping at a character escape or ending quote
	let r = '';
	while (true) {
		let c = str[idx];
		if (c === '\\') {
			// note: only basic escapes are accepted right now
			idx++;
			if (idx >= l) throw new Error('TinyG JSON Parse Error: Unexpected end of input');
			c = str[idx];
			if (c in strEscapes) {
				r += strEscapes[c];
			} else {
				throw new Error('TinyG JSON Parse Error: Unknown string escape: \\' + c);
			}
		} else if (c === '"') {
			idx++;
			return r;
		} else {
			r += c;
		}
		idx++;
		if (idx >= l) throw new Error('TinyG JSON Parse Error: Unexpected end of input');
	}
}

function parseUnwrappedString() {
	let start = idx;
	let c, cc;
	while (true) {		
		if (idx >= l) {
			let r = str.slice(start);
			if (!r.length) throw new Error('TinyG JSON Parse Error: Unexpected end of input');
			return r;
		}
		c = str[idx];
		cc = str.charCodeAt(idx);
		if (
			c !== '_' &&
			(cc < cc0 || cc > cc9) &&
			(cc < cca || cc > ccz) &&
			(cc < ccA || cc > ccZ)
		) {
			let r = str.slice(start, idx);
			if (!r.length) throw new Error('TinyG JSON Parse Error: Unexpected token ' + c);
			return r;
		}
		idx++;
	}
}

function parseObjectKey() {
	if (str[idx] === '"') {
		// Parse as string
		return parseString();
	} else {
		// Parse as unwrapped string
		return parseUnwrappedString();
	}
}

function parseObject() {
	// skip the beginning curly brace that's already been consumed
	idx++;
	if (idx >= l) throw new Error('TinyG JSON Parse Error: Unexpected end of input');
	let obj = {};
	while (true) {
		// Skip whitespace
		skipWhitespace();
		if (idx >= l) throw new Error('TinyG JSON Parse Error: Unexpected end of input');
		// Check for end of object
		if (str[idx] === '}') {
			idx++;
			return obj;
		}
		// Parse the object key
		let key = parseObjectKey();
		skipWhitespace();
		// Ensure the next character is :
		if (idx >= l) throw new Error('TinyG JSON Parse Error: Unexpected end of input');
		if (str[idx] !== ':') throw new Error('TinyG JSON Parse Error: Unexpected token ' + str[idx]);
		idx++;
		skipWhitespace();
		// Parse the value
		obj[key] = parseInternal();
		skipWhitespace();
		if (idx >= l) throw new Error('TinyG JSON Parse Error: Unexpected end of input');
		// Next character must be , or }
		if (str[idx] === ',') {
			idx++;
		} else if (str[idx] !== '}') {
			throw new Error('TinyG JSON Parse Error: Unexpected token ' + str[idx]);
		}
	}
}

function parseArray() {
	// skip the leading [
	idx++;
	if (idx >= l) throw new Error('TinyG JSON Parse Error: Unexpected end of input');
	let ar = [];
	while (true) {
		skipWhitespace();
		if (idx >= l) throw new Error('TinyG JSON Parse Error: Unexpected end of input');
		if (str[idx] === ']') {
			idx++;
			return ar;
		}
		ar.push(parseInternal());
		skipWhitespace();
		if (str[idx] === ',') {
			idx++;
		} else if (str[idx] !== ']') {
			throw new Error('TinyG JSON Parse Error: Unexpected token ' + str[idx]);
		}
	}
}

function parseNumber() {
	let start = idx;
	while (true) {
		if (idx >= l) break;
		let c = str[idx];
		let cc = str.charCodeAt(idx);
		if (
			c !== '-' &&
			c !== '.' &&
			c !== 'e' &&
			(cc < cc0 || cc > cc9)
		) {
			break;
		}
		idx++;
	}
	let numStr = str.slice(start, idx);
	if (!numStr.length || isNaN(numStr)) {
		throw new Error('TinyG JSON Parse Error: Invalid number ' + numStr);
	}
	return parseFloat(numStr);
}

function parseInternal() {
	if (idx >= l) throw new Error('TinyG JSON Parse Error: Unexpected end of input');
	let c = str[idx];
	let cc = str.charCodeAt(idx);
	if (c === '{') {
		// parse object
		return parseObject();
	} else if (c === '[') {
		// parse array
		return parseArray();
	} else if (c === '"') {
		// parse string
		return parseString();
	} else if (c === '-' || (cc >= cc0 && c <= cc9)) {
		// parse number
		return parseNumber();
	} else {
		// parse token (boolean, null)
		let tok = parseUnwrappedString();
		if (tok === 'null' || tok === 'n') return null;
		else if (tok === 'true' || tok === 't') return true;
		else if (tok === 'false' || tok === 'f') return false;
		else throw new Error('TinyG JSON Parse Error: Unexpected token ' + tok);
	}
}

function parse(s) {
	idx = 0;
	str = s;
	l = s.length;
	skipWhitespace();
	let r = parseInternal();
	skipWhitespace();
	if (idx < str.length) throw new Error('TinyG JSON Parse Error: Unexpected token ' + str[idx]);
	return r;
}

let validShortKeyRegex = /^[a-zA-Z][a-zA-Z0-9_]*$/;

function stringify(data, precision = 5) {
	if (data === undefined) return 'n';
	if (data === null) return 'n';
	if (data === true) return 't';
	if (data === false) return 'f';
	if (typeof data === 'number') {
		return '' + (+data.toFixed(precision));
	}
	if (typeof data === 'string') {
		return JSON.stringify(data);
	}
	if (Array.isArray(data)) {
		let ret = '[';
		for (let i = 0; i < data.length; i++) {
			if (i > 0) ret += ',';
			ret += stringify(data[i], precision);
		}
		return ret + ']';
	}
	if (typeof data === 'object') {
		let ret = '{';
		let first = true;
		for (let key in data) {
			let val = data[key];
			if (val !== undefined) {
				if (!first) ret += ',';
				else first = false;
				if (validShortKeyRegex.test(key)) {
					ret += key;
				} else {
					ret += stringify(key);
				}
				ret += ':' + stringify(val);
			}
		}
		return ret + '}';
	}
	throw new Error('Unsupported data type stringifying TinyG JSON');
}

module.exports = {
	parse,
	stringify
};

