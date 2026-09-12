import axios from "axios";

const BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:3000/api/v1";

// Access token lives only in memory (module scope) — never localStorage/sessionStorage.
// The refresh token is an httpOnly cookie the browser sends automatically.
let accessToken = null;
let stepUpToken = null;

export function setAccessToken(token) {
  accessToken = token;
}

export function getAccessToken() {
  return accessToken;
}

export function setStepUpToken(token) {
  stepUpToken = token;
}

export function clearSession() {
  accessToken = null;
  stepUpToken = null;
}

export const api = axios.create({
  baseURL: BASE_URL,
  withCredentials: true, // send the httpOnly refresh cookie
});

api.interceptors.request.use((config) => {
  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }
  if (stepUpToken && config.__stepUp) {
    config.headers["X-Step-Up-Token"] = stepUpToken;
  }
  return config;
});

// Queue concurrent requests while a single refresh is in-flight.
let refreshPromise = null;

async function refreshAccessToken() {
  if (!refreshPromise) {
    refreshPromise = axios
      .post(`${BASE_URL}/auth/refresh`, {}, { withCredentials: true })
      .then((res) => {
        setAccessToken(res.data.accessToken);
        return res.data.accessToken;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config;
    const code = error.response?.data?.error?.code;

    if (error.response?.status === 401 && !original._retry && original.url !== "/auth/refresh") {
      original._retry = true;
      try {
        const token = await refreshAccessToken();
        original.headers.Authorization = `Bearer ${token}`;
        return api(original);
      } catch (refreshErr) {
        clearSession();
        window.dispatchEvent(new CustomEvent("dms:session-expired"));
        return Promise.reject(refreshErr);
      }
    }

    if (error.response?.status === 403 && code === "STEP_UP_REQUIRED") {
      window.dispatchEvent(new CustomEvent("dms:step-up-required", { detail: { original } }));
    }

    return Promise.reject(error);
  }
);

export { refreshAccessToken, BASE_URL };
