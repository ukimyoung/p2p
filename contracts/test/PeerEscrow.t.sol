// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {PeerEscrow} from "../src/PeerEscrow.sol";

interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8, bytes32, bytes32);
    function prank(address sender) external;
    function expectRevert(bytes4 selector) external;
    function expectRevert() external;
    function warp(uint256 timestamp) external;
    function chainId(uint256 newChainId) external;
}

contract MockToken is ERC20 {
    uint256 public feeBps;
    address public blockedTo;

    constructor(string memory name_) ERC20(name_, name_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setFeeBps(uint256 value) external {
        feeBps = value;
    }

    function setBlockedTo(address value) external {
        blockedTo = value;
    }

    function transfer(address to, uint256 amount) public virtual override returns (bool) {
        if (to == blockedTo) return false;
        return super.transfer(to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public virtual override returns (bool) {
        if (to == blockedTo) return false;
        return super.transferFrom(from, to, amount);
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (from != address(0) && to != address(0) && feeBps != 0) {
            uint256 fee = amount * feeBps / 10_000;
            super._update(from, address(0), fee);
            super._update(from, to, amount - fee);
        } else {
            super._update(from, to, amount);
        }
    }
}

contract ReentrantToken is MockToken {
    address public target;
    bytes32 public orderId;
    bool public attempted;
    bool public reentrySucceeded;

    constructor() MockToken("ATTACK") {}

    function arm(address target_, bytes32 orderId_) external {
        target = target_;
        orderId = orderId_;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (!attempted && target != address(0)) {
            attempted = true;
            (reentrySucceeded,) = target.call(abi.encodeCall(PeerEscrow.depositMaker, (orderId)));
        }
        return super.transferFrom(from, to, amount);
    }
}

contract PeerEscrowTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant MAKER_KEY = 0xA11CE;
    uint256 private constant TAKER_KEY = 0xB0B;
    uint256 private constant WETH_AMOUNT = 0.4 ether;
    uint256 private constant QUOTE = 1_000e6;
    uint256 private constant FEE = 1e6;

    MockToken private usdc;
    MockToken private weth;
    PeerEscrow private escrow;
    address private maker;
    address private taker;
    address private treasury = address(0xBEEF);
    address private stranger = address(0xBAD);

    function setUp() public {
        maker = vm.addr(MAKER_KEY);
        taker = vm.addr(TAKER_KEY);
        usdc = new MockToken("USDC");
        weth = new MockToken("WETH");
        escrow = new PeerEscrow(address(usdc), address(weth), treasury, address(this), 100);
        usdc.mint(maker, 3_000e6);
        usdc.mint(taker, 3_000e6);
        weth.mint(maker, 2 ether);
        weth.mint(taker, 2 ether);
        vm.prank(maker);
        usdc.approve(address(escrow), type(uint256).max);
        vm.prank(maker);
        weth.approve(address(escrow), type(uint256).max);
        vm.prank(taker);
        usdc.approve(address(escrow), type(uint256).max);
        vm.prank(taker);
        weth.approve(address(escrow), type(uint256).max);
    }

    function _terms(bytes32 id, bool makerPaysUsdc) private view returns (PeerEscrow.Terms memory t) {
        t.orderId = id;
        t.maker = maker;
        t.taker = taker;
        t.makerNonce = uint256(id);
        t.takerNonce = uint256(id);
        t.makerToken = makerPaysUsdc ? address(usdc) : address(weth);
        t.takerToken = makerPaysUsdc ? address(weth) : address(usdc);
        t.makerDeposit = makerPaysUsdc ? QUOTE : WETH_AMOUNT;
        t.takerDeposit = makerPaysUsdc ? WETH_AMOUNT : QUOTE + FEE;
        t.makerReceive = makerPaysUsdc ? WETH_AMOUNT : QUOTE;
        t.takerReceive = makerPaysUsdc ? QUOTE - FEE : WETH_AMOUNT;
        t.fee = FEE;
        t.signatureDeadline = uint64(block.timestamp + 10 minutes);
    }

    function _signature(PeerEscrow target, PeerEscrow.Terms memory t, uint256 key) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, target.hashTerms(t));
        return abi.encodePacked(r, s, v);
    }

    function _open(PeerEscrow target, PeerEscrow.Terms memory t) private {
        target.openOrder(t, _signature(target, t, MAKER_KEY), _signature(target, t, TAKER_KEY));
    }

    function _openExpectRevert(PeerEscrow target, PeerEscrow.Terms memory t, bytes4 selector) private {
        bytes memory makerSig = _signature(target, t, MAKER_KEY);
        bytes memory takerSig = _signature(target, t, TAKER_KEY);
        vm.expectRevert(selector);
        target.openOrder(t, makerSig, takerSig);
    }

    function _assertEq(uint256 actual, uint256 expected) private pure {
        require(actual == expected, "unexpected amount or state");
    }

    function testTakerBuysWethAtomicSettlement() public {
        PeerEscrow.Terms memory t = _terms(bytes32(uint256(1)), false);
        _open(escrow, t);
        vm.prank(stranger);
        vm.expectRevert(PeerEscrow.Unauthorized.selector);
        escrow.depositMaker(t.orderId);
        vm.prank(taker);
        vm.expectRevert(PeerEscrow.InvalidState.selector);
        escrow.depositTaker(t.orderId);
        vm.prank(maker);
        escrow.depositMaker(t.orderId);
        _assertEq(escrow.locked(address(weth)), WETH_AMOUNT);
        _assertEq(weth.balanceOf(taker), 2 ether);
        vm.prank(taker);
        escrow.depositTaker(t.orderId);
        _assertEq(uint256(escrow.getOrder(t.orderId).state), uint256(PeerEscrow.State.SETTLED));
        _assertEq(usdc.balanceOf(maker), 4_000e6);
        _assertEq(usdc.balanceOf(taker), 1_999e6);
        _assertEq(usdc.balanceOf(treasury), FEE);
        _assertEq(weth.balanceOf(maker), 1.6 ether);
        _assertEq(weth.balanceOf(taker), 2.4 ether);
        _assertEq(escrow.locked(address(weth)), 0);
        vm.prank(taker);
        vm.expectRevert(PeerEscrow.InvalidState.selector);
        escrow.depositTaker(t.orderId);
        vm.warp(block.timestamp + 16 minutes);
        vm.expectRevert(PeerEscrow.InvalidState.selector);
        escrow.refundMaker(t.orderId);
    }

    function testTakerSellsWethFeeDeducted() public {
        PeerEscrow.Terms memory t = _terms(bytes32(uint256(2)), true);
        _open(escrow, t);
        vm.prank(maker);
        escrow.depositMaker(t.orderId);
        vm.prank(taker);
        escrow.depositTaker(t.orderId);
        _assertEq(usdc.balanceOf(maker), 2_000e6);
        _assertEq(usdc.balanceOf(taker), 3_999e6);
        _assertEq(usdc.balanceOf(treasury), FEE);
        _assertEq(weth.balanceOf(maker), 2.4 ether);
        _assertEq(weth.balanceOf(taker), 1.6 ether);
        _assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function testMakerRefundAtDeadlineBoundaryOnlyOnce() public {
        PeerEscrow.Terms memory t = _terms(bytes32(uint256(3)), false);
        _open(escrow, t);
        vm.prank(maker);
        escrow.depositMaker(t.orderId);
        uint256 deadline = escrow.getOrder(t.orderId).takerDeadline;
        vm.warp(deadline);
        vm.expectRevert(PeerEscrow.DeadlineNotPassed.selector);
        escrow.refundMaker(t.orderId);
        vm.warp(deadline + 1);
        vm.prank(taker);
        vm.expectRevert(PeerEscrow.DeadlinePassed.selector);
        escrow.depositTaker(t.orderId);
        vm.prank(stranger);
        escrow.refundMaker(t.orderId);
        _assertEq(uint256(escrow.getOrder(t.orderId).state), uint256(PeerEscrow.State.REFUNDED));
        _assertEq(weth.balanceOf(maker), 2 ether);
        _assertEq(escrow.locked(address(weth)), 0);
        vm.expectRevert(PeerEscrow.InvalidState.selector);
        escrow.refundMaker(t.orderId);
    }

    function testUnfundedCancellationAndExpiry() public {
        PeerEscrow.Terms memory t = _terms(bytes32(uint256(4)), false);
        _open(escrow, t);
        vm.prank(stranger);
        vm.expectRevert(PeerEscrow.Unauthorized.selector);
        escrow.cancelUnfunded(t.orderId);
        vm.prank(taker);
        escrow.cancelUnfunded(t.orderId);
        vm.prank(maker);
        vm.expectRevert(PeerEscrow.InvalidState.selector);
        escrow.depositMaker(t.orderId);
        PeerEscrow.Terms memory next = _terms(bytes32(uint256(5)), false);
        _open(escrow, next);
        uint256 deadline = escrow.getOrder(next.orderId).makerDeadline;
        vm.warp(deadline);
        vm.expectRevert(PeerEscrow.DeadlineNotPassed.selector);
        escrow.expireUnfunded(next.orderId);
        vm.warp(deadline + 1);
        vm.prank(maker);
        vm.expectRevert(PeerEscrow.DeadlinePassed.selector);
        escrow.depositMaker(next.orderId);
        vm.prank(stranger);
        escrow.expireUnfunded(next.orderId);
        _assertEq(uint256(escrow.getOrder(next.orderId).state), uint256(PeerEscrow.State.EXPIRED));
    }

    function testSignatureReplayNonceAndWrongSigner() public {
        PeerEscrow.Terms memory t = _terms(bytes32(uint256(6)), false);
        bytes memory makerSig = _signature(escrow, t, MAKER_KEY);
        bytes memory takerSig = _signature(escrow, t, TAKER_KEY);
        vm.expectRevert(PeerEscrow.InvalidSignature.selector);
        escrow.openOrder(t, takerSig, makerSig);
        t.fee += 1;
        vm.expectRevert(PeerEscrow.InvalidTerms.selector);
        escrow.openOrder(t, makerSig, takerSig);
        t.fee -= 1;
        escrow.openOrder(t, makerSig, takerSig);
        vm.expectRevert(PeerEscrow.InvalidState.selector);
        escrow.openOrder(t, makerSig, takerSig);
        PeerEscrow.Terms memory next = _terms(bytes32(uint256(7)), false);
        next.makerNonce = t.makerNonce;
        _openExpectRevert(escrow, next, PeerEscrow.NonceUnavailable.selector);
        PeerEscrow.Terms memory invalidated = _terms(bytes32(uint256(8)), false);
        vm.prank(taker);
        escrow.invalidateNonce(invalidated.takerNonce);
        _openExpectRevert(escrow, invalidated, PeerEscrow.NonceUnavailable.selector);
    }

    function testDomainAndSignatureDeadline() public {
        PeerEscrow.Terms memory t = _terms(bytes32(uint256(9)), false);
        bytes memory makerSig = _signature(escrow, t, MAKER_KEY);
        bytes memory takerSig = _signature(escrow, t, TAKER_KEY);
        PeerEscrow other = new PeerEscrow(address(usdc), address(weth), treasury, address(this), 100);
        vm.expectRevert(PeerEscrow.InvalidSignature.selector);
        other.openOrder(t, makerSig, takerSig);
        vm.chainId(block.chainid + 1);
        vm.expectRevert(PeerEscrow.InvalidSignature.selector);
        escrow.openOrder(t, makerSig, takerSig);
        vm.chainId(block.chainid - 1);
        vm.warp(t.signatureDeadline + 1);
        vm.expectRevert(PeerEscrow.DeadlinePassed.selector);
        escrow.openOrder(t, makerSig, takerSig);
    }

    function testInvalidTokenFeeAndConservation() public {
        PeerEscrow.Terms memory t = _terms(bytes32(uint256(10)), false);
        t.makerToken = address(0xDEAD);
        _openExpectRevert(escrow, t, PeerEscrow.InvalidTerms.selector);
        t = _terms(bytes32(uint256(10)), false);
        t.fee = 11e6;
        t.takerDeposit = QUOTE + t.fee;
        _openExpectRevert(escrow, t, PeerEscrow.InvalidTerms.selector);
        t = _terms(bytes32(uint256(10)), false);
        t.takerDeposit--;
        _openExpectRevert(escrow, t, PeerEscrow.InvalidTerms.selector);
        t = _terms(bytes32(uint256(10)), false);
        t.signatureDeadline = uint64(block.timestamp + 16 minutes);
        _openExpectRevert(escrow, t, PeerEscrow.DeadlinePassed.selector);
    }

    function testFeeOnTransferDepositRejected() public {
        weth.setFeeBps(100);
        PeerEscrow.Terms memory t = _terms(bytes32(uint256(11)), false);
        _open(escrow, t);
        vm.prank(maker);
        vm.expectRevert(PeerEscrow.InexactTransfer.selector);
        escrow.depositMaker(t.orderId);
        _assertEq(uint256(escrow.getOrder(t.orderId).state), uint256(PeerEscrow.State.OPEN));
        _assertEq(escrow.locked(address(weth)), 0);
    }

    function testFeeOnTransferTakerDepositRejected() public {
        PeerEscrow.Terms memory t = _terms(bytes32(uint256(17)), false);
        _open(escrow, t);
        vm.prank(maker);
        escrow.depositMaker(t.orderId);
        usdc.setFeeBps(100);
        vm.prank(taker);
        vm.expectRevert(PeerEscrow.InexactTransfer.selector);
        escrow.depositTaker(t.orderId);
        _assertEq(uint256(escrow.getOrder(t.orderId).state), uint256(PeerEscrow.State.MAKER_FUNDED));
        _assertEq(usdc.balanceOf(taker), 3_000e6);
        _assertEq(escrow.locked(address(weth)), WETH_AMOUNT);
    }

    function testFeeOnTransferPayoutRollsBackSettlement() public {
        PeerEscrow.Terms memory t = _terms(bytes32(uint256(18)), false);
        _open(escrow, t);
        vm.prank(maker);
        escrow.depositMaker(t.orderId);
        weth.setFeeBps(100);
        vm.prank(taker);
        vm.expectRevert(PeerEscrow.InexactTransfer.selector);
        escrow.depositTaker(t.orderId);
        _assertEq(uint256(escrow.getOrder(t.orderId).state), uint256(PeerEscrow.State.MAKER_FUNDED));
        _assertEq(weth.balanceOf(address(escrow)), WETH_AMOUNT);
        _assertEq(usdc.balanceOf(taker), 3_000e6);
        weth.setFeeBps(0);
        vm.prank(taker);
        escrow.depositTaker(t.orderId);
        _assertEq(uint256(escrow.getOrder(t.orderId).state), uint256(PeerEscrow.State.SETTLED));
    }

    function testInsufficientAllowanceLeavesMakerFunded() public {
        PeerEscrow.Terms memory t = _terms(bytes32(uint256(19)), false);
        _open(escrow, t);
        vm.prank(maker);
        escrow.depositMaker(t.orderId);
        vm.prank(taker);
        usdc.approve(address(escrow), 0);
        vm.prank(taker);
        vm.expectRevert();
        escrow.depositTaker(t.orderId);
        _assertEq(uint256(escrow.getOrder(t.orderId).state), uint256(PeerEscrow.State.MAKER_FUNDED));
        _assertEq(usdc.balanceOf(taker), 3_000e6);
        _assertEq(escrow.locked(address(weth)), WETH_AMOUNT);
    }

    function testMultipleOrdersKeepIndependentLocks() public {
        PeerEscrow.Terms memory first = _terms(bytes32(uint256(20)), false);
        PeerEscrow.Terms memory second = _terms(bytes32(uint256(21)), false);
        _open(escrow, first);
        _open(escrow, second);
        vm.prank(maker);
        escrow.depositMaker(first.orderId);
        vm.prank(maker);
        escrow.depositMaker(second.orderId);
        _assertEq(escrow.locked(address(weth)), 2 * WETH_AMOUNT);
        vm.prank(taker);
        escrow.depositTaker(first.orderId);
        _assertEq(escrow.locked(address(weth)), WETH_AMOUNT);
        vm.warp(escrow.getOrder(second.orderId).takerDeadline + 1);
        vm.prank(stranger);
        escrow.refundMaker(second.orderId);
        _assertEq(escrow.locked(address(weth)), 0);
        _assertEq(weth.balanceOf(address(escrow)), 0);
        _assertEq(uint256(escrow.getOrder(first.orderId).state), uint256(PeerEscrow.State.SETTLED));
        _assertEq(uint256(escrow.getOrder(second.orderId).state), uint256(PeerEscrow.State.REFUNDED));
    }

    function testConstructorRejectsNonContractToken() public {
        vm.expectRevert(PeerEscrow.InvalidTerms.selector);
        new PeerEscrow(address(usdc), stranger, treasury, address(this), 100);
    }

    function testPayoutFailureRollsBackTakerDeposit() public {
        PeerEscrow.Terms memory t = _terms(bytes32(uint256(12)), false);
        _open(escrow, t);
        vm.prank(maker);
        escrow.depositMaker(t.orderId);
        usdc.setBlockedTo(maker);
        vm.prank(taker);
        vm.expectRevert();
        escrow.depositTaker(t.orderId);
        _assertEq(uint256(escrow.getOrder(t.orderId).state), uint256(PeerEscrow.State.MAKER_FUNDED));
        _assertEq(usdc.balanceOf(taker), 3_000e6);
        _assertEq(weth.balanceOf(address(escrow)), WETH_AMOUNT);
        vm.warp(escrow.getOrder(t.orderId).takerDeadline + 1);
        escrow.refundMaker(t.orderId);
        _assertEq(weth.balanceOf(maker), 2 ether);
    }

    function testPauseCannotBlockRefund() public {
        PeerEscrow.Terms memory t = _terms(bytes32(uint256(13)), false);
        _open(escrow, t);
        vm.prank(maker);
        escrow.depositMaker(t.orderId);
        escrow.setPaused(true);
        PeerEscrow.Terms memory next = _terms(bytes32(uint256(14)), false);
        _openExpectRevert(escrow, next, PeerEscrow.DepositsPaused.selector);
        vm.prank(taker);
        vm.expectRevert(PeerEscrow.DepositsPaused.selector);
        escrow.depositTaker(t.orderId);
        vm.warp(escrow.getOrder(t.orderId).takerDeadline + 1);
        escrow.refundMaker(t.orderId);
        _assertEq(escrow.locked(address(weth)), 0);
        vm.prank(stranger);
        vm.expectRevert(PeerEscrow.Unauthorized.selector);
        escrow.setPaused(false);
    }

    function testReentrancyBlockedDuringMakerDeposit() public {
        ReentrantToken attack = new ReentrantToken();
        PeerEscrow target = new PeerEscrow(address(usdc), address(attack), treasury, address(this), 100);
        attack.mint(maker, 2 ether);
        vm.prank(maker);
        attack.approve(address(target), type(uint256).max);
        PeerEscrow.Terms memory t = _terms(bytes32(uint256(15)), false);
        t.makerToken = address(attack);
        _open(target, t);
        attack.arm(address(target), t.orderId);
        vm.prank(maker);
        target.depositMaker(t.orderId);
        require(attack.attempted() && !attack.reentrySucceeded(), "reentry was not blocked");
        _assertEq(target.locked(address(attack)), WETH_AMOUNT);
    }

    function testFuzzSettlementConservesBalances(uint16 feeSeed, bool makerPaysUsdc) public {
        uint256 fee = uint256(feeSeed) % (10e6 + 1);
        PeerEscrow.Terms memory t = _terms(bytes32(uint256(16)), makerPaysUsdc);
        t.fee = fee;
        if (makerPaysUsdc) t.takerReceive = QUOTE - fee;
        else t.takerDeposit = QUOTE + fee;
        _open(escrow, t);
        vm.prank(maker);
        escrow.depositMaker(t.orderId);
        vm.prank(taker);
        escrow.depositTaker(t.orderId);
        _assertEq(usdc.balanceOf(address(escrow)), 0);
        _assertEq(weth.balanceOf(address(escrow)), 0);
        _assertEq(escrow.locked(t.makerToken), 0);
        _assertEq(usdc.balanceOf(treasury), fee);
        _assertEq(usdc.balanceOf(maker) + usdc.balanceOf(taker) + usdc.balanceOf(treasury), 6_000e6);
        _assertEq(weth.balanceOf(maker) + weth.balanceOf(taker), 4 ether);
    }
}
