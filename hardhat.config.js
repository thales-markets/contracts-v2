require('@nomicfoundation/hardhat-toolbox');
require('hardhat-contract-sizer');
require('hardhat-abi-exporter');
require('@openzeppelin/hardhat-upgrades');
require('@nomiclabs/hardhat-web3');

const path = require('path');

/** @type import('hardhat/config').HardhatUserConfig */

const TEST_PRIVATE_KEY = vars.get('TEST_PRIVATE_KEY');
const PRIVATE_KEY = vars.get('PRIVATE_KEY');
const INFURA = vars.get('INFURA');
const OP_ETHERSCAN_KEY = vars.get('OP_ETHERSCAN_KEY');
const ARB_ETHERSCAN_KEY = vars.get('ARB_ETHERSCAN_KEY');
const ETHERSCAN_KEY = vars.get('ETHERSCAN_KEY');
const BASESCAN_KEY = vars.get('BASESCAN_KEY');
const REPORT_GAS = vars.get('REPORT_GAS');

module.exports = {
	solidity: {
		version: '0.8.20',
		settings: {
			optimizer: {
				enabled: true,
				runs: 100,
			},
		},
	},
	etherscan: {
		customChains: [
			{
				network: 'optimisticSepolia',
				chainId: 11155420,
				urls: {
					apiURL: 'https://api-sepolia-optimistic.etherscan.io/api',
					browserURL: 'https://sepolia-optimism.etherscan.io/',
				},
			},
		],
		apiKey: {
			sepolia: ETHERSCAN_KEY,
			optimisticSepolia: OP_ETHERSCAN_KEY,
			optimisticEthereum: OP_ETHERSCAN_KEY,
			arbitrumOne: ARB_ETHERSCAN_KEY,
			mainnet: ETHERSCAN_KEY,
			base: BASESCAN_KEY,
		},
	},
	networks: {
		mainnet: {
			url: `https://mainnet.infura.io/v3/${INFURA}`,
			accounts: [TEST_PRIVATE_KEY],
		},
		optimisticSepolia: {
			url: `https://optimism-sepolia.infura.io/v3/${INFURA}`,
			accounts: [TEST_PRIVATE_KEY],
		},
		sepolia: {
			url: `https://sepolia.infura.io/v3/${INFURA}`,
			accounts: [TEST_PRIVATE_KEY],
		},
		optimisticEthereum: {
			url: `https://optimism-mainnet.infura.io/v3/${INFURA}`,
			accounts: [PRIVATE_KEY],
		},
		arbitrumOne: {
			url: `https://arbitrum-mainnet.infura.io/v3/${INFURA}`,
			accounts: [PRIVATE_KEY],
		},
		baseMainnet: {
			url: `https://base-mainnet.infura.io/v3/${INFURA}`,
			accounts: [PRIVATE_KEY],
		},
	},
	gasReporter: {
		enabled: REPORT_GAS === 'true',
		showTimeSpent: true,
		currency: 'USD',
		maxMethodDiff: 25, // CI will fail if gas usage is > than this %
		// outputFile: 'test-gas-used.log',
	},
	sourcify: {
		enabled: false,
	},
	paths: {
		sources: './contracts',
		tests: './test',
		artifacts: path.join('build', 'artifacts'),
		cache: path.join('build', 'cache'),
	},
	abiExporter: {
		path: './scripts/abi',
		runOnCompile: true,
		clear: true,
		flat: true,
		only: [],
		spacing: 2,
	},
};
