const { ethers } = require('hardhat');
const { setTargetAddress, getTargetAddress, isTestNetwork } = require('../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const sportsAMMV2 = await ethers.getContractFactory('SportsAMMV2');
	const sportsAMMV2Address = getTargetAddress('SportsAMMV2', network);
	const sportsAMMV2Deployed = sportsAMMV2.attach(sportsAMMV2Address);

	const ticketMastercopy = await ethers.getContractFactory('TicketMastercopy');

	const ticketMastercopyDeployed = await ticketMastercopy.deploy();
	await ticketMastercopyDeployed.waitForDeployment();

	const ticketMastercopyAddress = await ticketMastercopyDeployed.getAddress();

	console.log('TicketMastercopy deployed on:', ticketMastercopyAddress);
	setTargetAddress('TicketMastercopy', network, ticketMastercopyAddress);
	await delay(5000);

	if (isTestNetwork(networkObj.chainId)) {
		await sportsAMMV2Deployed.setTicketMastercopy(ticketMastercopyAddress, {
			from: owner.address,
		});
		console.log('TicketMastercopy set in SportsAMMV2');
	}

	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: ticketMastercopyAddress,
			contract: 'contracts/Overtime/TicketMastercopy.sol:TicketMastercopy',
		});
	} catch (e) {
		console.log(e);
	}
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});

function delay(time) {
	return new Promise(function (resolve) {
		setTimeout(resolve, time);
	});
}
