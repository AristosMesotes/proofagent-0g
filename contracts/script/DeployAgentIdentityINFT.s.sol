// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.26;

import {AgentIdentityINFT, TEEDataVerifier, IERC7857DataVerifier} from "../src/AgentIdentityINFT.sol";

// DeployAgentIdentityINFT -- deploy the CANONICAL, AIverse-conformant ERC-7857 Agentic ID on 0G:
//   (1) the TEE/ZKP verifier oracle (TEEDataVerifier), (2) AgentIdentityINFT(issuer, oracle), (3) mint token #1
//   binding the agent + the MandateRegistry + the sealed intelligence (model hash + 0G Storage mind handle).
// Chain-guarded (0G only). All params from env; the broadcaster MUST equal AGENTID_ISSUER (the in-script mint).

interface IVm {
    function envAddress(string calldata name) external view returns (address);
    function envString(string calldata name) external view returns (string memory);
    function envBytes32(string calldata name) external view returns (bytes32);
    function startBroadcast() external;
    function stopBroadcast() external;
}

contract DeployAgentIdentityINFT {
    IVm internal constant VM = IVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant OG_MAINNET_CHAIN_ID = 16661;
    uint256 internal constant OG_TESTNET_CHAIN_ID = 16602;

    error WrongChain(uint256 actual);

    function run() external returns (AgentIdentityINFT inft, TEEDataVerifier oracle, uint256 tokenId) {
        requireOgChain(block.chainid);

        address issuer = VM.envAddress("AGENTID_ISSUER");
        address agent = VM.envAddress("AGENTID_AGENT");
        address mandate = VM.envAddress("AGENTID_MANDATE");
        bytes32 seal = VM.envBytes32("AGENTID_SEAL");
        string memory model = VM.envString("AGENTID_MODEL");

        VM.startBroadcast();
        oracle = new TEEDataVerifier();
        inft = new AgentIdentityINFT(issuer, IERC7857DataVerifier(address(oracle)));
        tokenId = inft.mint(agent, agent, mandate, keccak256(bytes(model)), seal, model);
        VM.stopBroadcast();
    }

    function requireOgChain(uint256 chainId) public pure {
        if (chainId != OG_MAINNET_CHAIN_ID && chainId != OG_TESTNET_CHAIN_ID) {
            revert WrongChain(chainId);
        }
    }
}
