"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");
const { createServer } = require("../server");

async function openSite(t) {
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === "win32" ? "msedge" : undefined),
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(15000);
  return { page, base: `http://127.0.0.1:${server.address().port}` };
}

test("username/password signup creates a dashboard and enables cookie-session checkout without OTP or browser tokens", async t => {
  const { page, base } = await openSite(t);
  let signedIn = false;
  const payloads = [];
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const user = { id: "1c799ade-fcd8-4e78-b23e-639419384a18", username: "Learner", role: "student", hasPassword: true };
  await page.route("**/api/account-auth", route => {
    const body = route.request().postDataJSON();
    payloads.push(body);
    signedIn = true;
    return route.fulfill({ status: 201, json: { signedIn: true, user } });
  });
  await page.route("**/api/session", route => route.fulfill({
    json: { provider: "mongodb", signedIn, ...(signedIn ? { user, plan: "Free" } : {}) },
  }));
  await page.route("**/api/config", route => route.fulfill({ json: {
    authProvider: "mongodb", emailOtpEnabled: false, providers: { stripe: true },
    plans: { Go: 750, Pro: 2500 }, paypalAmounts: {},
  } }));
  await page.route("**/api/checkout", route => {
    payloads.push(route.request().postDataJSON());
    assert.equal(route.request().headers().authorization, undefined);
    return route.fulfill({ status: 503, json: { error: "Test checkout remains pending." } });
  });
  await page.goto(`${base}/Account.html`);
  await page.locator("#password-signup-form:visible").waitFor();
  assert.equal(await page.locator("#otp-request-form, #local-admin-form").count(), 0);
  await page.locator("#signup-username").fill(user.username);
  await page.locator("#signup-password").fill("a memorable test passphrase");
  await page.locator("#password-signup-form button").click();
  await page.locator("#account-dashboard:not([hidden])").waitFor();
  assert.equal(await page.locator("#account-current-role").innerText(), "Student");
  assert.equal(await page.locator("#account-current-plan").innerText(), "Free");
  assert.equal(await page.locator("#account-admin").isVisible(), false);
  assert.equal(await page.locator("#account-paths a").getAttribute("href"), "Student-Plan.html");
  assert.equal(await page.evaluate(() => localStorage.getItem("visual-memory-lab.auth-session")), null);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(payloads, [
    { action: "signup", username: user.username, password: "a memorable test passphrase" },
  ]);
  await page.goto(`${base}/Membership.html?plan=Go`);
  await page.locator("#membership-buy:not([disabled])").waitFor();
  await page.locator("#membership-acknowledge").check();
  await page.locator("#membership-buy").click();
  await page.getByText("Test checkout remains pending.", { exact: true }).waitFor();
  assert.deepEqual(payloads.at(-1), { tier: "Go", provider: "stripe" });
  assert.deepEqual(errors, []);
});

test("database failure is visible without hiding Create account or falsely signing in", async t => {
  const { page, base } = await openSite(t);
  await page.route("**/api/account-auth", route => route.fulfill({
    status: 503, json: { error: "The server cannot connect to MongoDB." },
  }));
  await page.route("**/api/session", route => route.fulfill({ json: { provider: "mongodb", signedIn: false } }));
  await page.goto(`${base}/Account.html`);
  await page.locator("#password-signup-form:visible").waitFor();
  await page.locator("#signup-username").fill("Learner");
  await page.locator("#signup-password").fill("a memorable test passphrase");
  await page.locator("#password-signup-form button").click();
  await page.getByText("The server cannot connect to MongoDB.", { exact: true }).waitFor();
  assert.equal(await page.locator("#password-signup-form").isVisible(), true);
  assert.equal(await page.locator("#account-dashboard").isVisible(), false);
  assert.equal(await page.locator("#account-admin").isVisible(), false);
});

test("returning users log in with saved credentials and Sign out removes access", async t => {
  const { page, base } = await openSite(t);
  let signedIn = false;
  const user = { id: "1c799ade-fcd8-4e78-b23e-639419384a18", username: "Learner",
    role: "student", hasPassword: true };
  await page.route("**/api/account-auth", route => {
    const body = route.request().postDataJSON();
    assert.deepEqual(body, { action: "login", username: "Learner", password: "a memorable test passphrase" });
    signedIn = true;
    return route.fulfill({ json: { signedIn: true, user } });
  });
  await page.route("**/api/session", route => {
    if (route.request().method() === "DELETE") signedIn = false;
    return route.fulfill({ json: { provider: "mongodb", signedIn,
      ...(signedIn ? { user, plan: "Free" } : {}) } });
  });
  await page.goto(`${base}/Account.html`);
  await page.locator("#password-signup-form:visible").waitFor();
  await page.locator("#password-show-login").click();
  await page.locator("#login-username").fill("Learner");
  await page.locator("#login-password").fill("a memorable test passphrase");
  await page.locator("#password-login-form button").click();
  await page.locator("#account-dashboard:visible").waitFor();
  await page.locator("[data-site-account]:visible").waitFor();
  assert.equal(await page.locator("[data-site-account-name]").innerText(), "Hi, Learner");
  assert.equal(await page.locator("#account-current-role").innerText(), "Student");
  assert.equal(await page.locator("#account-current-plan").innerText(), "Free");
  assert.equal(await page.locator("#account-admin").isVisible(), false);
  assert.equal(await page.locator("#login-password").inputValue(), "");
  assert.match(await page.locator("#account-identity").innerText(), /Learner/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator("#account-sign-out").click();
  await page.locator("#password-account-panel:visible").waitFor();
  assert.equal(await page.locator("#account-dashboard").isVisible(), false);
  assert.equal(await page.locator("#account-admin").isVisible(), false);
  assert.equal(await page.locator("[data-site-account]").isVisible(), false);
});

test("the header identifies the current user across pages and account changes without overflowing mobile layouts", async t => {
  const { page, base } = await openSite(t);
  let username = "FirstLearner";
  await page.route("**/api/session", route => route.fulfill({ json: {
    provider: "mongodb", signedIn: Boolean(username),
    ...(username ? { user: { username, role: "student", hasPassword: true }, plan: "Free" } : {}),
  } }));
  await page.goto(base);
  const identity = page.locator("[data-site-account]");
  await identity.waitFor({ state: "visible" });
  assert.equal(await identity.innerText(), "Hi, FirstLearner");
  assert.equal(await identity.getAttribute("href"), "/Account.html");
  assert.equal(await page.locator("#site-primary-navigation").isVisible(), false);
  await page.goto(`${base}/Subjects.html`);
  await identity.waitFor({ state: "visible" });
  assert.equal(await identity.innerText(), "Hi, FirstLearner");

  username = "SecondLearnerWithALongAccountName";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForFunction(name => document.querySelector("[data-site-account-name]").textContent === `Hi, ${name}`, username);
  assert.equal(await identity.getAttribute("aria-label"), `Signed in as ${username}. Open account.`);
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await identity.isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}px`);
  }

  username = "";
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await identity.waitFor({ state: "hidden" });
  assert.equal(await page.locator("[data-site-account-name]").textContent(), "");
});
