"use node";

import { getAuthUserId } from "@convex-dev/auth/server";
import { action } from "./_generated/server";

const DEFAULT_ICE_SERVERS = [
  {
    urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"],
  },
];

function hasTurnServer(iceServers) {
  return iceServers.some((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.some(
      (url) => typeof url === "string" && /^turns?:/i.test(url),
    );
  });
}

export const getIceServers = action({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not authenticated");
    }

    const turnKeyId = process.env.CLOUDFLARE_TURN_KEY_ID;
    const turnApiToken = process.env.CLOUDFLARE_TURN_API_TOKEN;

    if (!turnKeyId || !turnApiToken) {
      return {
        iceServers: DEFAULT_ICE_SERVERS,
        relayAvailable: false,
        source: "stun-only",
      };
    }

    const response = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${turnKeyId}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${turnApiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl: 3600 }),
      },
    );

    if (!response.ok) {
      throw new Error(`Could not load TURN credentials (${response.status})`);
    }

    const payload = await response.json();
    const iceServers = Array.isArray(payload.iceServers)
      ? payload.iceServers
      : DEFAULT_ICE_SERVERS;
    if (!hasTurnServer(iceServers)) {
      throw new Error("The TURN service returned no relay servers");
    }
    return {
      iceServers,
      relayAvailable: true,
      source: "cloudflare-turn",
    };
  },
});
