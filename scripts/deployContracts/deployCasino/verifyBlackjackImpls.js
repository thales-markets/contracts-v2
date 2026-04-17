const { ethers } = require('hardhat');
const { getImplementationAddress } = require('@openzeppelin/upgrades-core');
const all = require('../../deployments.json');

const CHAINS = ['optimisticSepolia', 'optimisticEthereum', 'arbitrumOne', 'baseMainnet'];

const RPCS = {
	optimisticSepolia: `https://optimism-sepolia.infura.io/v3/${process.env.INFURA}`,
	optimisticEthereum: `https://optimism-mainnet.infura.io/v3/${process.env.INFURA}`,
	arbitrumOne: `https://arbitrum-mainnet.infura.io/v3/${process.env.INFURA}`,
	baseMainnet: `https://base-mainnet.infura.io/v3/${process.env.INFURA}`,
};

// Strip Solidity's metadata tail (a2646970667358...) which contains the IPFS hash of the
// build inputs and differs even for identical source. We compare stripped bytecode.
function stripMetadata(hex) {
	const h = hex.startsWith('0x') ? hex.slice(2) : hex;
	// Metadata is tagged with "a264..." or similar CBOR prefix + length (last 2 bytes).
	// Safer: look for known Solidity 0.8 metadata marker "a264697066735822".
	const marker = 'a264697066735822';
	const idx = h.lastIndexOf(marker);
	return idx > 0 ? '0x' + h.slice(0, idx) : '0x' + h;
}

async function main() {
	// Compile-local bytecode is pulled from the artifact that hardhat built during `compile`.
	const art = require('../../../build/artifacts/contracts/core/Casino/Blackjack.sol/Blackjack.json');
	const localDeployed = art.deployedBytecode.toLowerCase();
	const localStripped = stripMetadata(localDeployed);
	console.log(`Local deployedBytecode size: ${(localDeployed.length - 2) / 2} bytes`);
	console.log(`Local stripped size:         ${(localStripped.length - 2) / 2} bytes\n`);

	const results = [];

	for (const network of CHAINS) {
		const addrs = all[network];
		if (!addrs) {
			console.log(`${network}: no deployment entry — skip`);
			continue;
		}
		const provider = new ethers.JsonRpcProvider(RPCS[network]);
		const proxy = addrs.Blackjack;
		const savedImpl = addrs.BlackjackImplementation;
		try {
			const liveImpl = await getImplementationAddress(provider, proxy);
			const onchainBytecode = (await provider.getCode(liveImpl)).toLowerCase();
			const onchainStripped = stripMetadata(onchainBytecode);
			const liveSize = (onchainBytecode.length - 2) / 2;
			const savedMatches = liveImpl.toLowerCase() === (savedImpl || '').toLowerCase();
			const fullMatch = onchainBytecode === localDeployed;
			const strippedMatch = onchainStripped === localStripped;
			console.log(`--- ${network} ---`);
			console.log(`  proxy:              ${proxy}`);
			console.log(`  live impl:          ${liveImpl}`);
			console.log(`  deployments.json:   ${savedImpl}  ${savedMatches ? '✓' : '✗ MISMATCH'}`);
			console.log(`  live bytecode size: ${liveSize}`);
			console.log(
				`  full bytecode:      ${
					fullMatch
						? '✓ exact match'
						: strippedMatch
						  ? '~ stripped match (metadata differs, source-identical)'
						  : '✗ DIFFERS'
				}`
			);
			results.push({
				network,
				savedMatches,
				fullMatch,
				strippedMatch,
				liveImpl,
				savedImpl,
				liveSize,
			});
		} catch (e) {
			console.log(`${network}: error ${(e.message || e).slice(0, 120)}`);
			results.push({ network, error: e.message });
		}
		console.log();
	}

	console.log('=== Summary ===');
	for (const r of results) {
		if (r.error) {
			console.log(`${r.network.padEnd(22)} ERROR: ${r.error.slice(0, 80)}`);
			continue;
		}
		const status = r.fullMatch
			? '✓ EXACT'
			: r.strippedMatch
			  ? '~ SOURCE-MATCH (metadata differs)'
			  : '✗ DIFFERENT';
		const saved = r.savedMatches ? '' : '  [deployments.json out of sync]';
		console.log(`${r.network.padEnd(22)} ${status}${saved}`);
	}
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
