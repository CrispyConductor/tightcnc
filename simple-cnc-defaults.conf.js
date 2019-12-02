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
	}
};

