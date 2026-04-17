const { ethers } = require('hardhat');
const { getImplementationAddress } = require('@openzeppelin/upgrades-core');
const all = require('../../deployments.json');

function stripMetadata(hex) {
	const h = hex.startsWith('0x') ? hex.slice(2) : hex;
	const marker = 'a264697066735822';
	const idx = h.lastIndexOf(marker);
	return idx > 0 ? '0x' + h.slice(0, idx) : '0x' + h;
}

async function main() {
	const networkObj = await ethers.provider.getNetwork();
	const network = networkObj.name;
	const addrs = all[network];
	if (!addrs) throw new Error(`No deployments entry for ${network}`);

	const art = require('../../../build/artifacts/contracts/core/Casino/Blackjack.sol/Blackjack.json');
	const localDeployed = art.deployedBytecode.toLowerCase();
	const localStripped = stripMetadata(localDeployed);

	const proxy = addrs.Blackjack;
	const savedImpl = addrs.BlackjackImplementation;
	const liveImpl = await getImplementationAddress(ethers.provider, proxy);
	const onchainBytecode = (await ethers.provider.getCode(liveImpl)).toLowerCase();
	const onchainStripped = stripMetadata(onchainBytecode);

	const savedMatches = liveImpl.toLowerCase() === (savedImpl || '').toLowerCase();
	const fullMatch = onchainBytecode === localDeployed;
	const strippedMatch = onchainStripped === localStripped;

	console.log(`\n=== ${network} (chain ${networkObj.chainId}) ===`);
	console.log(`proxy:             ${proxy}`);
	console.log(`live impl:         ${liveImpl}`);
	console.log(`deployments.json:  ${savedImpl}  ${savedMatches ? '✓' : '✗ mismatch'}`);
	console.log(`local bytecode:    ${(localDeployed.length - 2) / 2} bytes`);
	console.log(`live bytecode:     ${(onchainBytecode.length - 2) / 2} bytes`);
	const verdict = fullMatch
		? '✓ EXACT MATCH (bytecode is identical)'
		: strippedMatch
		  ? '~ SOURCE MATCH (metadata tail differs — identical source)'
		  : '✗ DIFFERENT';
	console.log(`verdict:           ${verdict}`);

	// Sanity-probe split is live
	const bj = await ethers.getContractAt('Blackjack', proxy);
	const isSplit0 = await bj.isSplit(0);
	console.log(`isSplit(0):        ${isSplit0}   (split feature is live)`);
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
