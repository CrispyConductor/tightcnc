const pluginList = [ './autolevel', './move-splitter', './job-recovery' ];

const plugins = pluginList.map((reqName) => require(reqName));

module.exports.registerServerComponents = (tightcnc) => {
	for (let plugin of plugins) {
		if (plugin.registerServerComponents) plugin.registerServerComponents(tightcnc);
	}
};

module.exports.registerConsoleUIComponents = (consoleui) => {
	for (let plugin of plugins) {
		if (plugin.registerConsoleUIComponents) plugin.registerConsoleUIComponents(consoleui);
	}
};

