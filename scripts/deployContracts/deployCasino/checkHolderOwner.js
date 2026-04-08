const { ethers } = require('hardhat');
const { getTargetAddress } = require('../../helpers');

async function main() {
	const network = (await ethers.provider.getNetwork()).name;
	const holderAddress = getTargetAddress('FreeBetsHolder', network);
	const holder = await ethers.getContractAt('FreeBetsHolder', holderAddress);

	try {
		const owner = await holder.owner();
		console.log('FreeBetsHolder owner:', owner);
	} catch (e) {
		console.log('Error reading owner:', e.message?.slice(0, 100));
	}
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
