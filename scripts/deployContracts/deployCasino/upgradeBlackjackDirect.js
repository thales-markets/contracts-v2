// Direct upgrade of Blackjack on any network where the EOA signer is also the proxy admin.
// Unlike upgradeBlackjack.js this skips the `isTestNetwork` branch and always calls upgradeProxy.

const { ethers, upgrades, run } = require('hardhat');
const { getImplementationAddress } = require('@openzeppelin/upgrades-core');
const { setTargetAddress, getTargetAddress, delay } = require('../../helpers');

async function main() {
	const [owner] = await ethers.getSigners();
	const networkObj = await ethers.provider.getNetwork();
	const network = networkObj.name;

	console.log('Owner:  ', owner.address);
	console.log('Network:', network, `(chainId ${networkObj.chainId})`);

	const Blackjack = await ethers.getContractFactory('Blackjack');
	const proxyAddr = getTargetAddress('Blackjack', network);
	console.log('Blackjack proxy:', proxyAddr);

	const implBefore = await getImplementationAddress(ethers.provider, proxyAddr);
	console.log('Impl before:    ', implBefore);

	await upgrades.upgradeProxy(proxyAddr, Blackjack);

	const implAfter = await getImplementationAddress(ethers.provider, proxyAddr);
	console.log('Impl after:     ', implAfter);

	setTargetAddress('BlackjackImplementation', network, implAfter);
	await delay(5000);

	try {
		await run('verify:verify', { address: implAfter });
	} catch (e) {
		console.log('verify failed:', e.message || e);
	}
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error(err);
		process.exit(1);
	});
