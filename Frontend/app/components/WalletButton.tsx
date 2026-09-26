"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useConnectKitBridge } from "./ConnectKitBridgeContext";

const ConnectModal = dynamic(
  () => import("../../components/wallet/ConnectModal"),
  { ssr: false },
);

function truncate(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export default function WalletButton() {
  const { isConnected, address, isConnecting, disconnect } = useConnectKitBridge();
  const [modalOpen, setModalOpen] = useState(false);

  if (isConnecting) {
    return (
      <button
        disabled
        aria-label="Wallet connection in progress"
        title="Wallet connection in progress"
        className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium opacity-60"
        style={{ background: "var(--card)", border: "1px solid var(--border)", color: "var(--foreground)" }}
      >
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
        Connecting…
      </button>
    );
  }

  if (isConnected && address) {
    return (
      <div className="flex items-center gap-2">
        <span
          className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium"
          style={{ background: "var(--card)", border: "1px solid var(--border)", color: "var(--foreground)" }}
        >
          <span className="h-2 w-2 rounded-full bg-green-500" />
          {truncate(address)}
        </span>
        <button
          onClick={() => disconnect()}
          aria-label={`Disconnect wallet ${truncate(address)}`}
          title={`Disconnect wallet ${truncate(address)}`}
          className="rounded-lg px-3 py-2 text-sm font-medium transition-colors hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
          style={{ background: "var(--card)", border: "1px solid var(--border)", color: "var(--muted)" }}
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <>
      <button
        onClick={() => setModalOpen(true)}
        aria-label="Connect wallet"
        title="Connect wallet"
        className="rounded-lg px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
        style={{ background: "#3b82f6" }}
      >
        Connect Wallet
      </button>

      <ConnectModal isOpen={modalOpen} onClose={() => setModalOpen(false)} />
    </>
  );
}
