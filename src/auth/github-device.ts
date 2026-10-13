import { requestUrl } from "obsidian";
import {
  DEFAULT_CLIENT_ID,
  GITHUB_DEVICE_URL,
  GITHUB_TOKEN_URL,
} from "../constants";
import { DeviceFlowResponse } from "../types";

/**
 * Step 1: Request a device code from GitHub.
 * Returns the user_code to display and the device_code to poll with.
 */
export async function requestDeviceCode(clientId: string = DEFAULT_CLIENT_ID): Promise<DeviceFlowResponse> {
  const effectiveClientId = clientId.trim() || DEFAULT_CLIENT_ID;
  const response = await requestUrl({
    url: GITHUB_DEVICE_URL,
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `client_id=${effectiveClientId}&scope=repo`,
    throw: false,
  });

  if (response.status !== 200) {
    throw new Error(`GitHub Device Flow failed (${response.status}): ${response.text || "Unknown error"}`);
  }

  return response.json as DeviceFlowResponse;
}

/**
 * Step 2: Poll GitHub until the user approves or the code expires.
 * Includes resilience for mobile backgrounding & transient network disconnects (PR #10 fix).
 */
export async function pollForToken(
  deviceCode: string,
  intervalSeconds: number,
  expiresIn: number,
  clientId: string = DEFAULT_CLIENT_ID,
  onPollStart?: () => void
): Promise<string> {
  const effectiveClientId = clientId.trim() || DEFAULT_CLIENT_ID;
  const deadline = Date.now() + expiresIn * 1000;
  let currentInterval = Math.max(intervalSeconds, 5) * 1000;

  return new Promise((resolve, reject) => {
    const poll = async () => {
      if (Date.now() > deadline) {
        reject(new Error("Device code expired. Please connect again."));
        return;
      }

      onPollStart?.();

      let data: Record<string, string> | undefined;
      try {
        const response = await requestUrl({
          url: GITHUB_TOKEN_URL,
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: `client_id=${effectiveClientId}&device_code=${deviceCode}&grant_type=urn:ietf:params:oauth:grant-type:device_code`,
          throw: false,
        });
        data = response.json as Record<string, string>;
      } catch {
        // Network disruption or app backgrounded on mobile. Retry on next tick.
        setTimeout(poll, currentInterval);
        return;
      }

      if (!data) {
        setTimeout(poll, currentInterval);
        return;
      }

      if (data.access_token) {
        resolve(data.access_token);
        return;
      }

      switch (data.error) {
        case "authorization_pending":
          setTimeout(poll, currentInterval);
          break;
        case "slow_down":
          currentInterval += 5000;
          setTimeout(poll, currentInterval);
          break;
        case "expired_token":
          reject(new Error("Device code expired. Please reconnect."));
          break;
        case "access_denied":
          reject(new Error("Authorization was cancelled."));
          break;
        default:
          reject(new Error(`GitHub authorization error: ${data.error_description || data.error}`));
      }
    };

    setTimeout(poll, currentInterval);
  });
}
