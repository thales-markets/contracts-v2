const fs = require('fs');
const deployments = require('./deployments.json');

const getTargetAddress = (contractName, network) => {
	return deployments[network][contractName];
};

const setTargetAddress = (contractName, network, address) => {
	deployments[network][contractName] = address;
	fs.writeFileSync('scripts/deployments.json', JSON.stringify(deployments), function (err) {
		if (err) return console.log(err);
	});
};

// TODO: added OP and ARB as test networks
const isTestNetwork = (network) =>
	Number(network) === 420 ||
	Number(network) === 11155420 ||
	Number(network) === 10 ||
	Number(network) === 42161;

module.exports = {
	getTargetAddress,
	setTargetAddress,
	isTestNetwork,
};
