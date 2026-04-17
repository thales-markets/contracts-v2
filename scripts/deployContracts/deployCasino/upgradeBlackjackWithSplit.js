const { ethers, upgrades } = require('hardhat');
const { getImplementationAddress } = require('@openzeppelin/upgrades-core');
const { setTargetAddress, getTargetAddress, delay } = require('../../helpers');

async function main() {
	const [signer] = await ethers.getSigners();
	const networkObj = await ethers.provider.getNetwork();
	const network = networkObj.name;

	console.log(`Network: ${network} (chain ${networkObj.chainId})`);
	console.log(`Signer:  ${signer.address}`);

	const proxy = getTargetAddress('Blackjack', network);
	console.log(`\nProxy:       ${proxy}`);
	const implBefore = await getImplementationAddress(ethers.provider, proxy);
	console.log(`Impl before: ${implBefore}`);

	const Factory = await ethers.getContractFactory('Blackjack');
	await upgrades.upgradeProxy(proxy, Factory);
	await delay(8000);

	const implAfter = await getImplementationAddress(ethers.provider, proxy);
	console.log(`Impl after:  ${implAfter}`);
	setTargetAddress('BlackjackImplementation', network, implAfter);

	try {
		await hre.run('verify:verify', { address: implAfter });
	} catch (e) {
		console.log(`verify: ${(e.message || e).slice(0, 160)}`);
	}

	// Sanity: split() selector should exist
	const bj = await ethers.getContractAt('Blackjack', proxy);
	const isSplitExists = await bj.isSplit(0);
	console.log(`\nsplit() flow available. isSplit(0)=${isSplitExists}`);
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
