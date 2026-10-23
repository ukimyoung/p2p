// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Testnet prototype: one maker deposit, then atomic taker deposit and swap.
/// @dev No upgrade, arbitration, native ETH or arbitrary-token rescue path.
contract PeerEscrow is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint64 public constant MAKER_WINDOW = 15 minutes;
    uint64 public constant TAKER_WINDOW = 15 minutes;
    bytes32 public constant TERMS_TYPEHASH = keccak256(
        "Terms(bytes32 orderId,address maker,address taker,uint256 makerNonce,uint256 takerNonce,address makerToken,address takerToken,uint256 makerDeposit,uint256 takerDeposit,uint256 makerReceive,uint256 takerReceive,uint256 fee,uint64 signatureDeadline)"
    );

    enum State {
        NONE,
        OPEN,
        MAKER_FUNDED,
        SETTLED,
        CANCELLED,
        EXPIRED,
        REFUNDED
    }

    struct Terms {
        bytes32 orderId;
        address maker;
        address taker;
        uint256 makerNonce;
        uint256 takerNonce;
        address makerToken;
        address takerToken;
        uint256 makerDeposit;
        uint256 takerDeposit;
        uint256 makerReceive;
        uint256 takerReceive;
        uint256 fee;
        uint64 signatureDeadline;
    }

    struct Order {
        Terms terms;
        State state;
        uint64 makerDeadline;
        uint64 takerDeadline;
    }

    address public immutable quoteToken;
    address public immutable treasury;
    address public immutable guardian;
    uint256 public immutable maxFeeBps;
    bool public paused;
    mapping(address => bool) public allowedToken;
    mapping(address => mapping(uint256 => bool)) public nonceUsed;
    mapping(address => uint256) public locked;
    mapping(bytes32 => Order) private _orders;

    error InvalidTerms();
    error InvalidSignature();
    error NonceUnavailable();
    error InvalidState();
    error Unauthorized();
    error DeadlinePassed();
    error DeadlineNotPassed();
    error DepositsPaused();
    error InexactTransfer();

    event OrderOpened(
        bytes32 indexed orderId, address indexed maker, address indexed taker, bytes32 termsHash, uint64 makerDeadline
    );
    event MakerDeposited(bytes32 indexed orderId, address token, uint256 amount, uint64 takerDeadline);
    event OrderSettled(
        bytes32 indexed orderId,
        address makerToken,
        address takerToken,
        uint256 makerReceive,
        uint256 takerReceive,
        uint256 fee
    );
    event OrderCancelled(bytes32 indexed orderId);
    event OrderExpired(bytes32 indexed orderId);
    event MakerRefunded(bytes32 indexed orderId, address token, uint256 amount);
    event NonceInvalidated(address indexed signer, uint256 indexed nonce);
    event PauseChanged(bool paused);

    constructor(address quoteToken_, address otherToken_, address treasury_, address guardian_, uint256 maxFeeBps_)
        EIP712("PeerEscrow", "1")
    {
        if (
            quoteToken_ == address(0) || otherToken_ == address(0) || quoteToken_ == otherToken_
                || quoteToken_.code.length == 0 || otherToken_.code.length == 0 || treasury_ == address(0)
                || treasury_ == address(this) || guardian_ == address(0) || maxFeeBps_ > 10_000
        ) revert InvalidTerms();
        quoteToken = quoteToken_;
        treasury = treasury_;
        guardian = guardian_;
        maxFeeBps = maxFeeBps_;
        allowedToken[quoteToken_] = true;
        allowedToken[otherToken_] = true;
    }

    modifier whenActive() {
        if (paused) revert DepositsPaused();
        _;
    }

    function setPaused(bool value) external {
        if (msg.sender != guardian) revert Unauthorized();
        paused = value;
        emit PauseChanged(value);
    }

    function invalidateNonce(uint256 nonce) external {
        nonceUsed[msg.sender][nonce] = true;
        emit NonceInvalidated(msg.sender, nonce);
    }

    function hashTerms(Terms calldata t) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    TERMS_TYPEHASH,
                    t.orderId,
                    t.maker,
                    t.taker,
                    t.makerNonce,
                    t.takerNonce,
                    t.makerToken,
                    t.takerToken,
                    t.makerDeposit,
                    t.takerDeposit,
                    t.makerReceive,
                    t.takerReceive,
                    t.fee,
                    t.signatureDeadline
                )
            )
        );
    }

    function getOrder(bytes32 orderId) external view returns (Order memory) {
        return _orders[orderId];
    }

    function openOrder(Terms calldata t, bytes calldata makerSignature, bytes calldata takerSignature)
        external
        whenActive
    {
        if (
            t.orderId == bytes32(0) || t.maker == address(0) || t.taker == address(0) || t.maker == t.taker
                || t.maker == address(this) || t.taker == address(this) || t.makerToken == t.takerToken
                || !allowedToken[t.makerToken] || !allowedToken[t.takerToken] || t.makerDeposit == 0
                || t.takerDeposit == 0 || t.makerReceive == 0 || t.takerReceive == 0
        ) {
            revert InvalidTerms();
        }
        if (block.timestamp > t.signatureDeadline || t.signatureDeadline > block.timestamp + MAKER_WINDOW) {
            revert DeadlinePassed();
        }
        if (_orders[t.orderId].state != State.NONE) revert InvalidState();
        if (nonceUsed[t.maker][t.makerNonce] || nonceUsed[t.taker][t.takerNonce]) revert NonceUnavailable();

        uint256 quoteAmount;
        if (t.makerToken == quoteToken) {
            if (t.makerDeposit != t.takerReceive + t.fee || t.takerDeposit != t.makerReceive) {
                revert InvalidTerms();
            }
            quoteAmount = t.takerReceive;
        } else {
            if (
                t.takerToken != quoteToken || t.takerDeposit != t.makerReceive + t.fee
                    || t.makerDeposit != t.takerReceive
            ) revert InvalidTerms();
            quoteAmount = t.makerReceive;
        }
        if (t.fee > Math.mulDiv(quoteAmount, maxFeeBps, 10_000, Math.Rounding.Ceil)) revert InvalidTerms();

        bytes32 digest = hashTerms(t);
        if (ECDSA.recover(digest, makerSignature) != t.maker || ECDSA.recover(digest, takerSignature) != t.taker) {
            revert InvalidSignature();
        }

        nonceUsed[t.maker][t.makerNonce] = true;
        nonceUsed[t.taker][t.takerNonce] = true;
        uint64 makerDeadline = uint64(block.timestamp + MAKER_WINDOW);
        _orders[t.orderId] = Order(t, State.OPEN, makerDeadline, 0);
        emit OrderOpened(t.orderId, t.maker, t.taker, digest, makerDeadline);
    }

    function depositMaker(bytes32 orderId) external nonReentrant whenActive {
        Order storage order = _orders[orderId];
        if (order.state != State.OPEN) revert InvalidState();
        if (msg.sender != order.terms.maker) revert Unauthorized();
        if (block.timestamp > order.makerDeadline) revert DeadlinePassed();
        order.state = State.MAKER_FUNDED;
        order.takerDeadline = uint64(block.timestamp + TAKER_WINDOW);
        Terms storage t = order.terms;
        _pullExact(t.makerToken, t.maker, t.makerDeposit);
        locked[t.makerToken] += t.makerDeposit;
        emit MakerDeposited(orderId, t.makerToken, t.makerDeposit, order.takerDeadline);
    }

    function depositTaker(bytes32 orderId) external nonReentrant whenActive {
        Order storage order = _orders[orderId];
        if (order.state != State.MAKER_FUNDED) revert InvalidState();
        Terms storage t = order.terms;
        if (msg.sender != t.taker) revert Unauthorized();
        if (block.timestamp > order.takerDeadline) revert DeadlinePassed();
        order.state = State.SETTLED;
        _pullExact(t.takerToken, t.taker, t.takerDeposit);
        locked[t.makerToken] -= t.makerDeposit;
        if (t.makerToken == quoteToken) {
            _payExact(t.makerToken, t.taker, t.takerReceive);
            _payExact(t.makerToken, treasury, t.fee);
            _payExact(t.takerToken, t.maker, t.makerReceive);
        } else {
            _payExact(t.makerToken, t.taker, t.takerReceive);
            _payExact(t.takerToken, t.maker, t.makerReceive);
            _payExact(t.takerToken, treasury, t.fee);
        }
        emit OrderSettled(orderId, t.makerToken, t.takerToken, t.makerReceive, t.takerReceive, t.fee);
    }

    function cancelUnfunded(bytes32 orderId) external {
        Order storage order = _orders[orderId];
        if (order.state != State.OPEN) revert InvalidState();
        if (msg.sender != order.terms.maker && msg.sender != order.terms.taker) revert Unauthorized();
        order.state = State.CANCELLED;
        emit OrderCancelled(orderId);
    }

    function expireUnfunded(bytes32 orderId) external {
        Order storage order = _orders[orderId];
        if (order.state != State.OPEN) revert InvalidState();
        if (block.timestamp <= order.makerDeadline) revert DeadlineNotPassed();
        order.state = State.EXPIRED;
        emit OrderExpired(orderId);
    }

    function refundMaker(bytes32 orderId) external nonReentrant {
        Order storage order = _orders[orderId];
        if (order.state != State.MAKER_FUNDED) revert InvalidState();
        if (block.timestamp <= order.takerDeadline) revert DeadlineNotPassed();
        Terms storage t = order.terms;
        order.state = State.REFUNDED;
        locked[t.makerToken] -= t.makerDeposit;
        _payExact(t.makerToken, t.maker, t.makerDeposit);
        emit MakerRefunded(orderId, t.makerToken, t.makerDeposit);
    }

    function _pullExact(address tokenAddress, address from, uint256 amount) private {
        IERC20 token = IERC20(tokenAddress);
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), amount);
        if (token.balanceOf(address(this)) != beforeBalance + amount) revert InexactTransfer();
    }

    function _payExact(address tokenAddress, address to, uint256 amount) private {
        if (amount == 0) return;
        IERC20 token = IERC20(tokenAddress);
        uint256 beforeBalance = token.balanceOf(to);
        token.safeTransfer(to, amount);
        if (token.balanceOf(to) != beforeBalance + amount) revert InexactTransfer();
    }
}
