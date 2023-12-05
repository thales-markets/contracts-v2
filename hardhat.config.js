require('@nomicfoundation/hardhat-toolbox');
require('hardhat-contract-sizer');

/** @type import('hardhat/config').HardhatUserConfig */

const TEST_PRIVATE_KEY = vars.get('TEST_PRIVATE_KEY');
const INFURA = vars.get('INFURA');
const OP_ETHERSCAN_KEY = vars.get('OP_ETHERSCAN_KEY');
const REPORT_GAS = vars.get('REPORT_GAS');

module.exports = {
	solidity: {
		version: '0.8.19',
		settings: {
			optimizer: {
				enabled: true,
				runs: 200,
			},
		},
	},
	etherscan: {
		customChains: [
			{
				network: 'optimisticGoerli',
				chainId: 420,
				urls: {
					apiURL: 'https://api-goerli-optimism.etherscan.io/api',
					browserURL: 'https://goerli-optimism.etherscan.io/',
				},
			},
		],
		apiKey: {
			optimisticGoerli: OP_ETHERSCAN_KEY,
		},
	},
	networks: {
		optimisticGoerli: {
			url: `https://optimism-goerli.infura.io/v3/${INFURA}`,
			accounts: [TEST_PRIVATE_KEY],
		},
	},
	gasReporter: {
		enabled: REPORT_GAS,
		showTimeSpent: true,
		currency: 'USD',
		maxMethodDiff: 25, // CI will fail if gas usage is > than this %
		// outputFile: 'test-gas-used.log',
	},
	sourcify: {
		enabled: false,
	},
};
