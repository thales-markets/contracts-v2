const { ethers, upgrades } = require('hardhat');
const { getImplementationAddress } = require('@openzeppelin/upgrades-core');

const { setTargetAddress, getTargetAddress } = require('../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	// if (networkObj.chainId == 420) {
	// 	networkObj.name = 'optimisticGoerli';
	// 	network = 'optimisticGoerli';
	// }

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const defaultPaymentTokenAddress = getTargetAddress('DefaultPaymentToken', network);
	const safeBoxAddress = getTargetAddress('SafeBox', network);
	const referralsAddress = getTargetAddress('Referrals', network);

	const minBuyInAmount = ethers.parseEther('3');
	const maxTicketSize = 10;
	const maxSupportedAmount = ethers.parseEther('20000');
	const maxSupportedOdds = ethers.parseEther('0.01');
	const lpFee = ethers.parseEther('0.03');
	const safeBoxFee = ethers.parseEther('0.02');

	const sportsAMMV2 = await ethers.getContractFactory('SportsAMMV2');
	const sportsAMMV2Deployed = await upgrades.deployProxy(sportsAMMV2, [
		owner.address,
		defaultPaymentTokenAddress,
		safeBoxAddress,
		referralsAddress,
		minBuyInAmount,
		maxTicketSize,
		maxSupportedAmount,
		maxSupportedOdds,
		lpFee,
		safeBoxFee,
	]);
	await sportsAMMV2Deployed.waitForDeployment();

	const sportsAMMV2Address = await sportsAMMV2Deployed.getAddress();

	console.log('SportsAMMV2 deployed on:', sportsAMMV2Address);
	setTargetAddress('SportsAMMV2', network, sportsAMMV2Address);
	await delay(5000);

	const sportsAMMV2ImplementationAddress = await getImplementationAddress(
		ethers.provider,
		sportsAMMV2Address
	);

	console.log('SportsAMMV2 Implementation:', sportsAMMV2ImplementationAddress);
	setTargetAddress('SportsAMMV2Implementation', network, sportsAMMV2ImplementationAddress);
	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: sportsAMMV2ImplementationAddress,
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
