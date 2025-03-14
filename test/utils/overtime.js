const markets = require(`../../scripts/deployContracts/updateMerkleTree/markets.json`);
const { ONE_DAY_IN_SECS, ONE_WEEK_IN_SECS } = require('../constants/general');
const { getMerkleTree } = require('./merkleTree/merkleTree');
const fs = require('fs');

const getTradeDataItem = (market, position) => {
	return {
		gameId: market.gameId,
		sportId: market.sportId,
		typeId: market.typeId,
		maturity: market.maturity,
		status: market.status,
		line: market.line,
		playerId: market.playerProps.playerId,
		odds: market.odds,
		merkleProof: market.proof,
		position: position,
		combinedPositions: market.combinedPositions || new Array(market.odds.length).fill([]),
	};
};

const getTicketTradeData = () => {
	const marketsTree = require(`./merkleTree/treeMarketsAndHashes.json`);
	const nbaMoneylineCurrentRound = marketsTree[0];
	const nbaMoneylineNextRound = marketsTree[1];
	const nbaSpreadNextRound = marketsTree[1].childMarkets[0];

	const tradeDataCurrentRound = [];
	tradeDataCurrentRound.push(getTradeDataItem(nbaMoneylineCurrentRound, 0));

	const tradeDataNextRound = [];
	tradeDataNextRound.push(getTradeDataItem(nbaMoneylineNextRound, 0));

	const tradeDataCrossRounds = [];
	tradeDataCrossRounds.push(getTradeDataItem(nbaMoneylineCurrentRound, 0));
	tradeDataCrossRounds.push(getTradeDataItem(nbaSpreadNextRound, 1));

	const tradeDataTenMarketsCurrentRound = [];
	tradeDataTenMarketsCurrentRound.push(getTradeDataItem(marketsTree[2], 0));
	tradeDataTenMarketsCurrentRound.push(getTradeDataItem(marketsTree[3], 0));
	tradeDataTenMarketsCurrentRound.push(getTradeDataItem(marketsTree[4], 0));
	tradeDataTenMarketsCurrentRound.push(getTradeDataItem(marketsTree[5], 0));
	tradeDataTenMarketsCurrentRound.push(getTradeDataItem(marketsTree[6], 0));
	tradeDataTenMarketsCurrentRound.push(getTradeDataItem(marketsTree[7], 0));
	tradeDataTenMarketsCurrentRound.push(getTradeDataItem(marketsTree[8], 0));
	tradeDataTenMarketsCurrentRound.push(getTradeDataItem(marketsTree[9], 0));
	tradeDataTenMarketsCurrentRound.push(getTradeDataItem(marketsTree[10], 0));
	tradeDataTenMarketsCurrentRound.push(getTradeDataItem(marketsTree[11], 0));

	const tradeDataTenMarketsCurrentRoundImmutable = [];
	tradeDataTenMarketsCurrentRoundImmutable.push(getTradeDataItem(marketsTree[2], 0));
	tradeDataTenMarketsCurrentRoundImmutable.push(getTradeDataItem(marketsTree[3], 0));
	tradeDataTenMarketsCurrentRoundImmutable.push(getTradeDataItem(marketsTree[4], 0));
	tradeDataTenMarketsCurrentRoundImmutable.push(getTradeDataItem(marketsTree[5], 0));
	tradeDataTenMarketsCurrentRoundImmutable.push(getTradeDataItem(marketsTree[6], 0));
	tradeDataTenMarketsCurrentRoundImmutable.push(getTradeDataItem(marketsTree[7], 0));
	tradeDataTenMarketsCurrentRoundImmutable.push(getTradeDataItem(marketsTree[8], 0));
	tradeDataTenMarketsCurrentRoundImmutable.push(getTradeDataItem(marketsTree[9], 0));
	tradeDataTenMarketsCurrentRoundImmutable.push(getTradeDataItem(marketsTree[10], 0));
	tradeDataTenMarketsCurrentRoundImmutable.push(getTradeDataItem(marketsTree[11], 0));

	const tradeDataThreeMarketsCurrentRound = [];
	tradeDataThreeMarketsCurrentRound.push(getTradeDataItem(marketsTree[0].childMarkets[3], 0));
	tradeDataThreeMarketsCurrentRound.push(getTradeDataItem(marketsTree[1], 0));
	tradeDataThreeMarketsCurrentRound.push(getTradeDataItem(marketsTree[2], 0));

	const tradeDataTenMarketsCurrentRoundFirst = [];
	tradeDataTenMarketsCurrentRoundFirst.push(getTradeDataItem(marketsTree[2], 0));

	const tradeDataTenMarketsCurrentRoundSecond = [];
	tradeDataTenMarketsCurrentRoundSecond.push(getTradeDataItem(marketsTree[3], 0));

	const tradeDataTenMarketsCurrentRoundThird = [];
	tradeDataTenMarketsCurrentRoundThird.push(getTradeDataItem(marketsTree[4], 0));

	const tradeDataTenMarketsCurrentRoundFourth = [];
	tradeDataTenMarketsCurrentRoundFourth.push(getTradeDataItem(marketsTree[5], 0));

	const tradeDataTenMarketsCurrentRoundFifth = [];
	tradeDataTenMarketsCurrentRoundFifth.push(getTradeDataItem(marketsTree[6], 0));

	const tradeDataTenMarketsCurrentRoundSixth = [];
	tradeDataTenMarketsCurrentRoundSixth.push(getTradeDataItem(marketsTree[7], 0));

	const tradeDataTenMarketsCurrentRoundSeventh = [];
	tradeDataTenMarketsCurrentRoundSeventh.push(getTradeDataItem(marketsTree[8], 0));

	const tradeDataTenMarketsCurrentRoundEighth = [];
	tradeDataTenMarketsCurrentRoundEighth.push(getTradeDataItem(marketsTree[9], 0));

	const tradeDataTenMarketsCurrentRoundNineth = [];
	tradeDataTenMarketsCurrentRoundNineth.push(getTradeDataItem(marketsTree[10], 0));

	const tradeDataTenMarketsCurrentRoundTenth = [];
	tradeDataTenMarketsCurrentRoundTenth.push(getTradeDataItem(marketsTree[11], 0));

	const tradeDataSameGames = [];
	tradeDataSameGames.push(getTradeDataItem(marketsTree[0], 0));
	tradeDataSameGames.push(getTradeDataItem(marketsTree[0], 0));

	const sameGameWithFirstPlayerProps = [];
	sameGameWithFirstPlayerProps.push(getTradeDataItem(marketsTree[0].childMarkets[3], 0));
	sameGameWithFirstPlayerProps.push(getTradeDataItem(marketsTree[0], 0));

	const sameGameWithSecondPlayerProps = [];
	sameGameWithSecondPlayerProps.push(getTradeDataItem(marketsTree[0], 0));
	sameGameWithSecondPlayerProps.push(getTradeDataItem(marketsTree[0].childMarkets[3], 0));

	const sameGameDifferentPlayersDifferentProps = [];
	sameGameDifferentPlayersDifferentProps.push(getTradeDataItem(marketsTree[0].childMarkets[3], 0));
	sameGameDifferentPlayersDifferentProps.push(getTradeDataItem(marketsTree[0].childMarkets[5], 0));

	const sameGameSamePlayersDifferentProps = [];
	sameGameSamePlayersDifferentProps.push(getTradeDataItem(marketsTree[0].childMarkets[3], 0));
	sameGameSamePlayersDifferentProps.push(getTradeDataItem(marketsTree[0].childMarkets[4], 0));

	const tradeDataNotActive = [];
	tradeDataNotActive.push(getTradeDataItem(marketsTree[0].childMarkets[1], 0));

	return {
		tradeDataCurrentRound,
		tradeDataNextRound,
		tradeDataCrossRounds,
		tradeDataTenMarketsCurrentRound,
		tradeDataTenMarketsCurrentRoundImmutable,
		tradeDataThreeMarketsCurrentRound,
		tradeDataTenMarketsCurrentRoundFirst,
		tradeDataTenMarketsCurrentRoundSecond,
		tradeDataTenMarketsCurrentRoundThird,
		tradeDataTenMarketsCurrentRoundFourth,
		tradeDataTenMarketsCurrentRoundFifth,
		tradeDataTenMarketsCurrentRoundSixth,
		tradeDataTenMarketsCurrentRoundSeventh,
		tradeDataTenMarketsCurrentRoundEighth,
		tradeDataTenMarketsCurrentRoundNineth,
		tradeDataTenMarketsCurrentRoundTenth,
		tradeDataSameGames,
		sameGameWithFirstPlayerProps,
		sameGameWithSecondPlayerProps,
		sameGameDifferentPlayersDifferentProps,
		sameGameSamePlayersDifferentProps,
		tradeDataNotActive,
	};
};

const createMerkleTree = async () => {
	const today = Math.round(new Date().getTime() / 1000);
	const tomorrow = today + ONE_DAY_IN_SECS;
	const nextWeek = tomorrow + ONE_WEEK_IN_SECS;

	const newMarkets = [];
	markets.forEach((market, index) => {
		market.maturity = index === 1 ? nextWeek : tomorrow;
		market.childMarkets.forEach((childMarket) => {
			childMarket.maturity = index === 1 ? nextWeek : tomorrow;
		});
		newMarkets.push(market);
	});

	const { root, treeMarketsAndHashes } = await getMerkleTree(newMarkets);

	fs.writeFileSync(
		`test/utils/merkleTree/treeMarketsAndHashes.json`,
		JSON.stringify(treeMarketsAndHashes),
		function (err) {
			if (err) return console.log(err);
		}
	);

	return root;
};

module.exports = {
	getTicketTradeData,
	getTradeDataItem,
	createMerkleTree,
};
