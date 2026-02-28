// // splynx-express-single-file.js
// // Single-file Express + Splynx API v2.0 client example
// // Run with: node splynx-express-single-file.js

// const express = require('express');
// const axios = require('axios');
// const crypto = require('crypto');

// const app = express();
// const port = 3000;

// // ────────────────────────────────────────────────
// //  Configuration – CHANGE THESE VALUES
// // ────────────────────────────────────────────────
// const CONFIG = {
//   SPLYNX_BASE_URL: 'https://infinetbroadband-portal.com.au/api/2.0/',   // ← change this
//   API_KEY:        '107c483d15e930b41b8d70affdd08632',                         // ← change this
//   API_SECRET:     '9b8b46ce928bea980a8d092a288372e0',                      // ← change this
//   USE_ACCESS_TOKEN: true,                                      // recommended
// };

// // ────────────────────────────────────────────────
// //  Splynx API Client (embedded)
// // ────────────────────────────────────────────────
// class SplynxApiClient {
//   constructor(config) {
//     this.baseUrl = config.SPLYNX_BASE_URL;
//     this.apiKey = config.API_KEY;
//     this.apiSecret = config.API_SECRET;
//     this.accessToken = null;
//     this.accessTokenExpiration = 0;
//     this.refreshToken = null;
//     this.refreshTokenExpiration = 0;
//     this.useAccessToken = config.USE_ACCESS_TOKEN !== false;
//   }

//   generateSignature(nonce) {
//     const data = nonce + this.apiKey;
//     const hmac = crypto.createHmac('sha256', this.apiSecret);
//     hmac.update(data);
//     return hmac.digest('hex').toUpperCase();
//   }

//   getSignatureAuthHeader() {
//     const nonce = Math.round(Date.now() / 1000 * 100);
//     const signature = this.generateSignature(nonce);
//     const params = { key: this.apiKey, nonce, signature };
//     return `Splynx-EA (${new URLSearchParams(params).toString()})`;
//   }

//   async generateAccessToken() {
//     try {
//       const nonce = Math.floor(Date.now() / 1000);
//       const response = await axios.post(
//         `${this.baseUrl}admin/auth/tokens`,
//         {
//           auth_type: 'api_key',
//           key: this.apiKey,
//           nonce,
//           signature: this.generateSignature(nonce),
//         },
//         { headers: { 'Content-Type': 'application/json' } }
//       );

//       const data = response.data;
//       this.accessToken = data.access_token;
//       this.accessTokenExpiration = data.access_token_expiration;
//       this.refreshToken = data.refresh_token;
//       this.refreshTokenExpiration = data.refresh_token_expiration;

//       console.log('Access token generated');
//       console.log(data);
//       return data;
//     } catch (err) {
//       console.error('Token generation failed:', err.response?.data || err.message);
//       throw err;
//     }
//   }

//   async renewAccessToken() {
//     if (!this.refreshToken) throw new Error('No refresh token available');

//     try {
//       const response = await axios.get(
//         `${this.baseUrl}admin/auth/tokens/${this.refreshToken}`,
//         {
//           headers: {
//             Authorization: `Splynx-EA (access_token=${this.accessToken})`,
//           },
//         }
//       );

//       const data = response.data;
//       this.accessToken = data.access_token;
//       this.accessTokenExpiration = data.access_token_expiration;
//       this.refreshToken = data.refresh_token;
//       this.refreshTokenExpiration = data.refresh_token_expiration;

//       console.log('Access token renewed');
//       return data;
//     } catch (err) {
//       console.error('Token renew failed:', err.response?.data || err.message);
//       throw err;
//     }
//   }

//   isTokenExpired(bufferSeconds = 30) {
//     return Date.now() / 1000 + bufferSeconds > this.accessTokenExpiration;
//   }

//   async request(method, endpoint, data = null, params = {}) {
//     let headers = { 'Content-Type': 'application/json' };

//     if (this.useAccessToken && this.accessToken) {
//       if (this.isTokenExpired()) {
//         console.log('Token expired → renewing...');
//         await this.renewAccessToken();
//       }
//       headers.Authorization = `Splynx-EA (access_token=${this.accessToken})`;
//     } else {
//       headers.Authorization = this.getSignatureAuthHeader();
//     }

//     const url = `${this.baseUrl}${endpoint}`;

//     try {
//       const config = { method, url, headers, params, ...(data && { data }) };
//       const response = await axios(config);
//       return response.data;
//     } catch (err) {
//       if (err.response?.status === 401) {
//         console.warn('401 → retrying after renew...');
//         await this.renewAccessToken();
//         return this.request(method, endpoint, data, params); // retry once
//       }
//       console.error(`[${method}] ${endpoint} failed:`, err.response?.data || err.message);
//       throw err.response?.data || err;
//     }
//   }

//   // ─── Convenience methods ────────────────────────────────────────

//   async getCustomers(query = {}) {
//     return this.request('GET', 'admin/customers/customer', null, query);
//   }

//   async getCustomer(id) {
//     return this.request('GET', `admin/customers/customer/${id}`);
//   }

//   async getOnlineCustomers() {
//     return this.request('GET', 'admin/customers/customers-online');
//   }

//   async getInternetTariffs() {
//     return this.request('GET', 'admin/tariffs/internet');
//   }

//   async getServiceTrafficUsage(serviceId, withTexts = true) {
//     return this.request('GET', `admin/fup/usage/${serviceId}?with_texts=${withTexts}`);
//   }

//   async get(endpoint, params = {}) {
//     return this.request('GET', endpoint, null, params);
//   }

//   async post(endpoint, data) {
//     return this.request('POST', endpoint, data);
//   }
// }

// // ────────────────────────────────────────────────
// //  Initialize client
// // ────────────────────────────────────────────────
// const splynx = new SplynxApiClient(CONFIG);

// // Ensure we have a token when server starts
// (async () => {
//   try {
//     if (CONFIG.USE_ACCESS_TOKEN) {
//       await splynx.generateAccessToken();
//     }
//   } catch (err) {
//     console.error('Initial token generation failed. API calls may fail.');
//   }
// })();

// // ────────────────────────────────────────────────
// //  Express Middleware – ensure token
// // ────────────────────────────────────────────────
// app.use(express.json());

// app.use(async (req, res, next) => {
//   try {
//     if (CONFIG.USE_ACCESS_TOKEN && !splynx.accessToken) {
//       await splynx.generateAccessToken();
//     }
//     next();
//   } catch (err) {
//     res.status(503).json({
//       error: 'Splynx API not ready',
//       details: err.message,
//     });
//   }
// });

// // ────────────────────────────────────────────────
// //  Routes – Examples
// // ────────────────────────────────────────────────

// app.get('/health', (req, res) => {
//   res.json({
//     status: 'ok',
//     splynx: {
//       hasToken: !!splynx.accessToken,
//       tokenExpires: splynx.accessTokenExpiration ? new Date(splynx.accessTokenExpiration * 1000).toISOString() : null,
//     },
//   });
// });

// app.get('/api/customers', async (req, res) => {
//   try {
//     const data = await splynx.getCustomers({
//       limit: 10,
//       offset: 0,
//       // main_attributes: { login: ['LIKE', 'test%'] }  // uncomment & adjust
//     });
//     res.json(data);
//   } catch (err) {
//     res.status(500).json({ error: 'Failed to fetch customers', details: err });
//   }
// });

// app.get('/api/customer/:id', async (req, res) => {
//   try {
//     const data = await splynx.getCustomer(req.params.id);
//     res.json(data);
//   } catch (err) {
//     res.status(err?.code || 500).json({ error: err.message || 'Customer not found' });
//   }
// });

// app.get('/api/online', async (req, res) => {
//   try {
//     const data = await splynx.getOnlineCustomers();
//     res.json(data);
//   } catch (err) {
//     res.status(500).json({ error: 'Failed to get online customers' });
//   }
// });

// app.get('/api/tariffs/internet', async (req, res) => {
//   try {
//     const data = await splynx.getInternetTariffs();
//     res.json(data);
//   } catch (err) {
//     res.status(500).json({ error: 'Failed to fetch internet tariffs' });
//   }
// });

// app.get('/api/traffic/:serviceId', async (req, res) => {
//   try {
//     const data = await splynx.getServiceTrafficUsage(req.params.serviceId, true);
//     res.json(data);
//   } catch (err) {
//     res.status(500).json({ error: 'Failed to get traffic usage' });
//   }
// });

// // Catch-all for other endpoints (proxy style)
// // Remove this invalid line:
// // app.all('/api/*', async (req, res) => { ... });

// // Put this instead (I recommend option 1):
// app.all(/^\/api\/.*/, async (req, res) => {
//   try {
//     let endpoint = req.path.replace(/^\/api\//, '');

//     // Optional: prevent requesting api/ itself
//     if (!endpoint) {
//       return res.status(400).json({ error: 'Missing endpoint path after /api/' });
//     }

//     const data = await splynx.request(
//       req.method,
//       endpoint,
//       req.method !== 'GET' && req.method !== 'HEAD' ? req.body : null,
//       req.query
//     );

//     res.json(data);
//   } catch (err) {
//     const status = err?.code || err?.response?.status || 500;
//     res.status(status).json({
//       error: 'Splynx proxy error',
//       message: err.message || err.internal_code || 'Request failed',
//       splynx_error: err?.internal_code ? err : undefined
//     });
//   }
// });

// // ────────────────────────────────────────────────
// //  Start server
// // ────────────────────────────────────────────────
// app.listen(port, () => {
//   console.log(`╔════════════════════════════════════════════╗`);
//   console.log(`║  Splynx API Proxy running on port ${port}    ║`);
//   console.log(`╚════════════════════════════════════════════╝`);
//   console.log(`Base URL : ${CONFIG.SPLYNX_BASE_URL}`);
//   console.log(`Auth type: ${CONFIG.USE_ACCESS_TOKEN ? 'Access Token' : 'Signature'}`);
//   console.log(`Try: http://localhost:${port}/api/customers`);
//   console.log(``);
// });

// splynx-express-single-file.js
// Single-file Express + Splynx API v2.0 client
// Now includes: Customers, Online, Traffic, Internet Tariffs, Locations, Administrators, Partners

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
const port = 3000;

app.use(express.json());

// ────────────────────────────────────────────────
//  Configuration – CHANGE THESE VALUES
// ────────────────────────────────────────────────
const CONFIG = {
  SPLYNX_BASE_URL: 'https://infinetbroadband-portal.com.au/api/2.0/',   // ← change this
  API_KEY:        '107c483d15e930b41b8d70affdd08632',                         // ← change this
  API_SECRET:     '9b8b46ce928bea980a8d092a288372e0',                      // ← change this
  USE_ACCESS_TOKEN: true,                                      // recommended
};

// ────────────────────────────────────────────────
//  Splynx API Client
// ────────────────────────────────────────────────
class SplynxApiClient {
  constructor(config) {
    this.baseUrl = config.SPLYNX_BASE_URL;
    this.apiKey = config.API_KEY;
    this.apiSecret = config.API_SECRET;
    this.accessToken = null;
    this.accessTokenExpiration = 0;
    this.refreshToken = null;
    this.refreshTokenExpiration = 0;
    this.useAccessToken = config.USE_ACCESS_TOKEN !== false;
  }

  generateSignature(nonce) {
    const data = nonce + this.apiKey;
    const hmac = crypto.createHmac('sha256', this.apiSecret);
    hmac.update(data);
    return hmac.digest('hex').toUpperCase();
  }

  getSignatureAuthHeader() {
    const nonce = Math.round(Date.now() / 1000 * 100);
    const signature = this.generateSignature(nonce);
    const params = { key: this.apiKey, nonce, signature };
    return `Splynx-EA (${new URLSearchParams(params).toString()})`;
  }

  async generateAccessToken() {
    try {
      const nonce = Math.floor(Date.now() / 1000);
      const response = await axios.post(
        `${this.baseUrl}admin/auth/tokens`,
        {
          auth_type: 'api_key',
          key: this.apiKey,
          nonce,
          signature: this.generateSignature(nonce),
        },
        { headers: { 'Content-Type': 'application/json' } }
      );

      const data = response.data;
      this.accessToken = data.access_token;
      this.accessTokenExpiration = data.access_token_expiration;
      this.refreshToken = data.refresh_token;
      this.refreshTokenExpiration = data.refresh_token_expiration;

      console.log('Access token generated');
      return data;
    } catch (err) {
      console.error('Token generation failed:', err.response?.data || err.message);
      throw err;
    }
  }

  async renewAccessToken() {
    if (!this.refreshToken) throw new Error('No refresh token available');

    try {
      const response = await axios.get(
        `${this.baseUrl}admin/auth/tokens/${this.refreshToken}`,
        {
          headers: { Authorization: `Splynx-EA (access_token=${this.accessToken})` },
        }
      );

      const data = response.data;
      this.accessToken = data.access_token;
      this.accessTokenExpiration = data.access_token_expiration;
      this.refreshToken = data.refresh_token;
      this.refreshTokenExpiration = data.refresh_token_expiration;

      console.log('Access token renewed');
      return data;
    } catch (err) {
      console.error('Token renew failed:', err.response?.data || err.message);
      throw err;
    }
  }

  isTokenExpired(bufferSeconds = 30) {
    return Date.now() / 1000 + bufferSeconds > this.accessTokenExpiration;
  }

  async request(method, endpoint, data = null, params = {}) {
    let headers = { 'Content-Type': 'application/json' };

    if (this.useAccessToken && this.accessToken) {
      if (this.isTokenExpired()) {
        console.log('Token expired → renewing...');
        await this.renewAccessToken();
      }
      headers.Authorization = `Splynx-EA (access_token=${this.accessToken})`;
    } else {
      headers.Authorization = this.getSignatureAuthHeader();
    }

    const url = `${this.baseUrl}${endpoint}`;

    try {
      const config = { method, url, headers, params, ...(data && { data }) };
      const response = await axios(config);
      return response.data;
    } catch (err) {
      if (err.response?.status === 401) {
        console.warn('401 → retrying after renew...');
        await this.renewAccessToken();
        return this.request(method, endpoint, data, params);
      }
      console.error(`[${method}] ${endpoint} failed:`, err.response?.data || err.message);
      throw err.response?.data || err;
    }
  }

  // ─── Convenience methods ────────────────────────────────────────

  // Customers
  async getCustomers(query = {}) {
    return this.request('GET', 'admin/customers/customer', null, query);
  }

  async getCustomer(id) {
    return this.request('GET', `admin/customers/customer/${id}`);
  }

  async getOnlineCustomers() {
    return this.request('GET', 'admin/customers/customers-online');
  }

  async getServiceTrafficUsage(serviceId, withTexts = true) {
    return this.request('GET', `admin/fup/usage/${serviceId}?with_texts=${withTexts}`);
  }

  // Internet Tariffs
  async listInternetTariffs(params = {}) {
    return this.request('GET', 'admin/tariffs/internet', null, params);
  }

  async getInternetTariff(id) {
    return this.request('GET', `admin/tariffs/internet/${id}`);
  }

  async createInternetTariff(data) {
    return this.request('POST', 'admin/tariffs/internet', data);
  }

  async updateInternetTariff(id, data) {
    return this.request('PUT', `admin/tariffs/internet/${id}`, data);
  }

  async deleteInternetTariff(id) {
    return this.request('DELETE', `admin/tariffs/internet/${id}`);
  }

  // ─── Administration ─────────────────────────────────────────────

  // Locations
  async listLocations(params = {}) {
    return this.request('GET', 'admin/administration/locations', null, params);
  }

  async getLocation(id) {
    return this.request('GET', `admin/administration/locations/${id}`);
  }

  async createLocation(data) {
    return this.request('POST', 'admin/administration/locations', data);
  }

  async updateLocation(id, data) {
    return this.request('PUT', `admin/administration/locations/${id}`, data);
  }

  async deleteLocation(id) {
    return this.request('DELETE', `admin/administration/locations/${id}`);
  }

  // Administrators
  async listAdministrators(params = {}) {
    return this.request('GET', 'admin/administration/administrators', null, params);
  }

  async getAdministrator(id) {
    return this.request('GET', `admin/administration/administrators/${id}`);
  }

  async createAdministrator(data) {
    return this.request('POST', 'admin/administration/administrators', data);
  }

  async updateAdministrator(id, data) {
    return this.request('PUT', `admin/administration/administrators/${id}`, data);
  }

  async deleteAdministrator(id) {
    return this.request('DELETE', `admin/administration/administrators/${id}`);
  }

  // Partners
  async listPartners(params = {}) {
    return this.request('GET', 'admin/administration/partners', null, params);
  }

  async getPartner(id) {
    return this.request('GET', `admin/administration/partners/${id}`);
  }

  async createPartner(data) {
    return this.request('POST', 'admin/administration/partners', data);
  }

  async updatePartner(id, data) {
    return this.request('PUT', `admin/administration/partners/${id}`, data);
  }

  async deletePartner(id) {
    return this.request('DELETE', `admin/administration/partners/${id}`);
  }
}

// ────────────────────────────────────────────────
//  Initialize client
// ────────────────────────────────────────────────
const splynx = new SplynxApiClient(CONFIG);

(async () => {
  try {
    if (CONFIG.USE_ACCESS_TOKEN) {
      await splynx.generateAccessToken();
    }
  } catch (err) {
    console.error('Initial token generation failed. Some API calls may fail.');
  }
})();

// ────────────────────────────────────────────────
//  Middleware – ensure token
// ────────────────────────────────────────────────
app.use(async (req, res, next) => {
  try {
    if (CONFIG.USE_ACCESS_TOKEN && !splynx.accessToken) {
      await splynx.generateAccessToken();
    }
    next();
  } catch (err) {
    res.status(503).json({
      error: 'Splynx API not ready',
      details: err.message,
    });
  }
});

// ────────────────────────────────────────────────
//  Routes
// ────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    splynx: {
      hasToken: !!splynx.accessToken,
      tokenExpires: splynx.accessTokenExpiration ? new Date(splynx.accessTokenExpiration * 1000).toISOString() : null,
    },
  });
});

// Customers
app.get('/api/customers', async (req, res) => {
  try { res.json(await splynx.getCustomers({ limit: 10, offset: 0 })); }
  catch (err) { res.status(500).json({ error: 'Failed to fetch customers', details: err }); }
});

app.get('/api/customer/:id', async (req, res) => {
  try { res.json(await splynx.getCustomer(req.params.id)); }
  catch (err) { res.status(500).json({ error: 'Customer not found' }); }
});

app.get('/api/online', async (req, res) => {
  try { res.json(await splynx.getOnlineCustomers()); }
  catch (err) { res.status(500).json({ error: 'Failed to get online customers' }); }
});

app.get('/api/traffic/:serviceId', async (req, res) => {
  try { res.json(await splynx.getServiceTrafficUsage(req.params.serviceId)); }
  catch (err) { res.status(500).json({ error: 'Failed to get traffic usage' }); }
});

// Internet Tariffs
app.get('/api/tariffs/internet', async (req, res) => {
  try { res.json(await splynx.listInternetTariffs(req.query)); }
  catch (err) { res.status(500).json({ error: 'Failed to list internet tariffs' }); }
});

app.get('/api/tariffs/internet/:id', async (req, res) => {
  try { res.json(await splynx.getInternetTariff(req.params.id)); }
  catch (err) { res.status(500).json({ error: 'Failed to get tariff' }); }
});

app.post('/api/tariffs/internet', async (req, res) => {
  try { res.status(201).json(await splynx.createInternetTariff(req.body)); }
  catch (err) { res.status(500).json({ error: 'Failed to create tariff' }); }
});

app.put('/api/tariffs/internet/:id', async (req, res) => {
  try { res.json(await splynx.updateInternetTariff(req.params.id, req.body)); }
  catch (err) { res.status(500).json({ error: 'Failed to update tariff' }); }
});

app.delete('/api/tariffs/internet/:id', async (req, res) => {
  try {
    await splynx.deleteInternetTariff(req.params.id);
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete tariff' });
  }
});

// ─── Administration ─────────────────────────────────────────────

app.get('/api/locations', async (req, res) => {
  try { res.json(await splynx.listLocations(req.query)); }
  catch (err) { res.status(500).json({ error: 'Failed to list locations' }); }
});

app.get('/api/locations/:id', async (req, res) => {
  try { res.json(await splynx.getLocation(req.params.id)); }
  catch (err) { res.status(500).json({ error: 'Location not found' }); }
});

app.post('/api/locations', async (req, res) => {
  try { res.status(201).json(await splynx.createLocation(req.body)); }
  catch (err) { res.status(500).json({ error: 'Failed to create location' }); }
});

app.put('/api/locations/:id', async (req, res) => {
  try { res.json(await splynx.updateLocation(req.params.id, req.body)); }
  catch (err) { res.status(500).json({ error: 'Failed to update location' }); }
});

app.delete('/api/locations/:id', async (req, res) => {
  try {
    await splynx.deleteLocation(req.params.id);
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete location' });
  }
});

app.get('/api/administrators', async (req, res) => {
  try { res.json(await splynx.listAdministrators(req.query)); }
  catch (err) { res.status(500).json({ error: 'Failed to list administrators' }); }
});

app.get('/api/administrators/:id', async (req, res) => {
  try { res.json(await splynx.getAdministrator(req.params.id)); }
  catch (err) { res.status(500).json({ error: 'Admin not found' }); }
});

app.get('/api/partners', async (req, res) => {
  try { res.json(await splynx.listPartners(req.query)); }
  catch (err) { res.status(500).json({ error: 'Failed to list partners' }); }
});

app.get('/api/partners/:id', async (req, res) => {
  try { res.json(await splynx.getPartner(req.params.id)); }
  catch (err) { res.status(500).json({ error: 'Partner not found' }); }
});

// ─── Catch-all proxy for any other /api/* path ────────────────────
app.all(/^\/api\/.*/, async (req, res) => {
  try {
    let endpoint = req.path.replace(/^\/api\//, '');
    if (!endpoint) return res.status(400).json({ error: 'Missing endpoint after /api/' });

    const data = await splynx.request(
      req.method,
      endpoint,
      req.method !== 'GET' && req.method !== 'HEAD' ? req.body : null,
      req.query
    );

    if (req.method === 'DELETE') {
      res.status(204).send();
    } else {
      res.json(data);
    }
  } catch (err) {
    const status = err?.code || err?.response?.status || 500;
    res.status(status).json({
      error: 'Splynx proxy error',
      message: err.message || err.internal_code || 'Request failed',
      details: err
    });
  }
});

// ────────────────────────────────────────────────
//  Start server
// ────────────────────────────────────────────────
app.listen(port, () => {
  console.log(`Splynx API Proxy running on http://localhost:${port}`);
  console.log(`Available endpoints (examples):`);
  console.log(`  GET    /api/customers`);
  console.log(`  GET    /api/online`);
  console.log(`  GET    /api/tariffs/internet`);
  console.log(`  GET    /api/locations`);
  console.log(`  GET    /api/administrators`);
  console.log(`  GET    /api/partners`);
  console.log(`  POST   /api/locations       (body required)`);
  console.log(``);
});