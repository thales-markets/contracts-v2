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
	'test/contracts/Overtime/Casino/ThreeCardPokerEdgeSim.js',
	'test/contracts/Overtime/Casino/HiLoEdgeSim.js',
	'test/contracts/Overtime/Casino/PlinkoEdgeSim.js',
	'test/contracts/Overtime/Casino/KenoEdgeSim.js',
	'test/contracts/Overtime/Casino/OvertimeBonusHoldemEdgeSim.js',
	'test/contracts/Overtime/Casino/CrossValidatePlinko.js',
	'test/contracts/Overtime/Casino/CrossValidateKeno.js',
	'test/contracts/Overtime/Casino/CrossValidateHiLo.js',
	'test/contracts/Overtime/Casino/CrossValidateThreeCardPoker.js',
	'test/contracts/Overtime/Casino/CrossValidateVideoPoker.js',
	'test/contracts/Overtime/Casino/CrossValidateUltimateHoldem.js',
	'test/contracts/Overtime/Casino/CrossValidateBonusHoldem.js',
].map((p) => path.resolve(__dirname, p));

task(TASK_TEST_GET_TEST_FILES).setAction(async (args, _hre, runSuper) => {
	const files = await runSuper(args);
	// Always filter edge sims out of `hardhat test` and `hardhat coverage`. Edge sims are
	// 10k–100k-hand simulations that take hours under coverage instrumentation. The previous
	// "explicit-files-respected" branch was broken: coverage passes a glob-expanded list to
	// `args.testFiles`, so distinguishing explicit naming from glob expansion isn't possible
	// from this hook. To run a single edge sim, invoke it via mocha (`npx mocha --require
	// hardhat/register test/.../EdgeAudit.js`) or temporarily remove it from EXCLUDED_EDGE_TESTS
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
