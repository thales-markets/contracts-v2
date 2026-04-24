// keep these requires (including verify v2)
require('@nomicfoundation/hardhat-toolbox');
require('@nomicfoundation/hardhat-verify');
require('hardhat-contract-sizer');
require('hardhat-abi-exporter');
require('@openzeppelin/hardhat-upgrades');
require('@nomiclabs/hardhat-web3');

const path = require('path');
const { task } = require('hardhat/config');
const { TASK_TEST_GET_TEST_FILES } = require('hardhat/builtin-tasks/task-names');

// ---------------------------------------------------------------------------
// Edge / simulation tests — excluded from the default `npx hardhat test` run
// so the full suite stays fast. They still run when invoked explicitly:
//   npx hardhat test test/contracts/Overtime/Casino/EdgeAudit.js
// Add new slow simulation files here when they land.
// ---------------------------------------------------------------------------
const EXCLUDED_EDGE_TESTS = [
	'test/contracts/Overtime/Casino/EdgeAudit.js',
	'test/contracts/Overtime/Casino/SlotsSimulation.js',
	'test/contracts/Overtime/Casino/BlackjackStrategies.js',
].map((p) => path.resolve(__dirname, p));

task(TASK_TEST_GET_TEST_FILES).setAction(async (args, _hre, runSuper) => {
	const files = await runSuper(args);
	// If the user passed explicit test files, respect their selection.
	if (args.testFiles && args.testFiles.length > 0) return files;
	return files.filter((f) => !EXCLUDED_EDGE_TESTS.includes(path.resolve(f)));
});

const TEST_PRIVATE_KEY = vars.get('TEST_PRIVATE_KEY');
const PRIVATE_KEY = vars.get('PRIVATE_KEY');
const INFURA = vars.get('INFURA');
const ETHERSCAN_KEY = vars.get('ETHERSCAN_KEY'); // single key for v2
const REPORT_GAS = vars.get('REPORT_GAS');

module.exports = {
	solidity: {
		version: '0.8.20',
		settings: { optimizer: { enabled: true, runs: 100 } },
	},

	// ✅ v2: single key
	etherscan: {
		apiKey: ETHERSCAN_KEY,
		// ➜ Add ONLY this custom chain for optimisticSepolia
		customChains: [
			{
				network: 'optimisticSepolia',
				chainId: 11155420,
				urls: {
					apiURL: 'https://api-sepolia-optimistic.etherscan.io/api',
					browserURL: 'https://sepolia-optimism.etherscan.io',
				},
			},
		],
	},

	networks: {
		mainnet: {
			url: `https://mainnet.infura.io/v3/${INFURA}`,
			accounts: [TEST_PRIVATE_KEY],
			chainId: 1,
		},
		sepolia: {
			url: `https://sepolia.infura.io/v3/${INFURA}`,
			accounts: [TEST_PRIVATE_KEY],
			chainId: 11155111,
		},
		optimisticSepolia: {
			url: `https://optimism-sepolia.infura.io/v3/${INFURA}`,
			accounts: [TEST_PRIVATE_KEY],
			chainId: 11155420,
		},
		optimisticEthereum: {
			url: `https://optimism-mainnet.infura.io/v3/${INFURA}`,
			accounts: [PRIVATE_KEY],
			chainId: 10,
		},
		arbitrumOne: {
			url: `https://arbitrum-mainnet.infura.io/v3/${INFURA}`,
			accounts: [PRIVATE_KEY],
			chainId: 42161,
		},
		baseMainnet: {
			url: `https://base-mainnet.infura.io/v3/${INFURA}`,
			accounts: [PRIVATE_KEY],
			chainId: 8453,
		},
		polygon: {
			url: 'https://polygon-mainnet.infura.io/v3/' + INFURA,
			accounts: [PRIVATE_KEY],
			chainId: 137,
		},
	},

	gasReporter: {
		enabled: REPORT_GAS === 'true',
		showTimeSpent: true,
		currency: 'USD',
		maxMethodDiff: 25,
	},

	sourcify: { enabled: false },

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
