const { ethers } = require('hardhat');
const { getTargetAddress } = require('../../helpers');

async function main() {
	const network = (await ethers.provider.getNetwork()).name;
	const proxy = getTargetAddress('Blackjack', network);
	const slot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
	const raw = await ethers.provider.getStorage(proxy, slot);
	const impl = ethers.getAddress('0x' + raw.slice(26));

	const code = await ethers.provider.getCode(impl);
	const sizeBytes = (code.length - 2) / 2;
	console.log(`${network}`);
	console.log(`  proxy:  ${proxy}`);
	console.log(`  impl:   ${impl}`);
	console.log(`  size:   ${sizeBytes} bytes`);
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
