const { ethers, upgrades } = require('hardhat');
const { getImplementationAddress } = require('@openzeppelin/upgrades-core');
const { setTargetAddress, getTargetAddress, delay } = require('../../helpers');

/**
 * Deploys a NEW FreeBetsHolder implementation and (on networks where EOA is proxy admin)
 * upgrades the proxy too. On networks where ProtocolDAO is admin, only prepareUpgrade
 * runs — hand the returned impl address to the DAO to execute `upgradeAndCall` on the proxy.
 */
async function main() {
	const [signer] = await ethers.getSigners();
	const networkObj = await ethers.provider.getNetwork();
	const network = networkObj.name;

	console.log(`Network: ${network} (chain ${networkObj.chainId})`);
	console.log(`Signer:  ${signer.address}\n`);

	const proxy = getTargetAddress('FreeBetsHolder', network);
	if (!proxy) throw new Error('FreeBetsHolder not in deployments.json');

	const implBefore = await getImplementationAddress(ethers.provider, proxy);
	console.log(`Proxy:       ${proxy}`);
	console.log(`Impl before: ${implBefore}\n`);

	const Factory = await ethers.getContractFactory('FreeBetsHolder');

	const newImpl = await upgrades.prepareUpgrade(proxy, Factory, {
		kind: 'transparent',
	});
	console.log(`New implementation deployed: ${newImpl}`);
	setTargetAddress('FreeBetsHolderImplementation', network, newImpl);

	await delay(8000);

	try {
		await hre.run('verify:verify', { address: newImpl });
	} catch (e) {
		console.log(`verify: ${(e.message || e).slice(0, 160)}`);
	}

	console.log(
		'\nNext step: ProtocolDAO must call upgradeAndCall(proxy, newImpl, 0x) on the ProxyAdmin'
	);
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
