const { ethers } = require('hardhat');
const all = require('../../deployments.json');

async function main() {
	const networkObj = await ethers.provider.getNetwork();
	const network = networkObj.name;
	const addrs = all[network];
	console.log(`Network: ${network} (chain ${networkObj.chainId})`);

	const pf = await ethers.getContractAt('IPriceFeed', addrs.PriceFeed);
	for (const k of ['ETH', 'OVER', 'WETH']) {
		try {
			const r = await pf.rateForCurrency(ethers.encodeBytes32String(k));
			console.log(`rateForCurrency(${k}) = ${r.toString()}`);
		} catch (e) {
			console.log(`rateForCurrency(${k}) error: ${(e.message || e).slice(0, 80)}`);
		}
	}

	console.log('\nAddresses in deployments.json:');
	for (const k of [
		'VRFCoordinator',
		'VRFSubscriptionId',
		'VRFKeyHash',
		'SportsAMMV2Manager',
		'PriceFeed',
		'DefaultCollateral',
		'WETH',
		'OVER',
	]) {
		console.log(`  ${k}: ${addrs[k]}`);
	}
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
