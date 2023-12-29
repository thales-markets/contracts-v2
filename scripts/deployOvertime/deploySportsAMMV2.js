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
	const sportsAMMV2ManagerAddress = getTargetAddress('SportsAMMV2Manager', network);
	const sportsAMMV2RiskManagerAddress = getTargetAddress('SportsAMMV2RiskManager', network);
	const stakingThalesAddress = getTargetAddress('StakingThales', network);
	const referralsAddress = getTargetAddress('Referrals', network);
	const safeBoxAddress = getTargetAddress('SafeBox', network);

	const safeBoxFee = ethers.parseEther('0.02');
	const minBuyInAmount = ethers.parseEther('3');
	const maxTicketSize = 10;
	const maxSupportedAmount = ethers.parseEther('20000');
	const maxSupportedOdds = ethers.parseEther('0.01');

	const minimalTimeLeftToMaturity = 10;
	const expiryDuration = 7776000;

	const sportsAMMV2 = await ethers.getContractFactory('SportsAMMV2');
	const sportsAMMV2Deployed = await upgrades.deployProxy(sportsAMMV2, [
		owner.address,
		defaultPaymentTokenAddress,
		sportsAMMV2ManagerAddress,
		sportsAMMV2RiskManagerAddress,
		referralsAddress,
		stakingThalesAddress,
		safeBoxAddress,
	]);
	await sportsAMMV2Deployed.waitForDeployment();

	const sportsAMMV2Address = await sportsAMMV2Deployed.getAddress();

	console.log('SportsAMMV2 deployed on:', sportsAMMV2Address);
	setTargetAddress('SportsAMMV2', network, sportsAMMV2Address);
	await delay(5000);

	await sportsAMMV2Deployed.setAmounts(
		safeBoxFee,
		minBuyInAmount,
		maxTicketSize,
		maxSupportedAmount,
		maxSupportedOdds,
		{
			from: owner.address,
		}
	);
	console.log('Amounts set in SportsAMMV2');

	await sportsAMMV2Deployed.setTimes(minimalTimeLeftToMaturity, expiryDuration, {
		from: owner.address,
	});
	console.log('Times set in SportsAMMV2');

	const sportsAMMV2ImplementationAddress = await getImplementationAddress(
		ethers.provider,
		sportsAMMV2Address
	);

	console.log('SportsAMMV2 Implementation:', sportsAMMV2ImplementationAddress);
	setTargetAddress('SportsAMMV2Implementation', network, sportsAMMV2ImplementationAddress);
	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: sportsAMMV2Address,
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
