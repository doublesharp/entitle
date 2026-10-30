import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { signInEmail } from "../src/sign-in-email.ts";

for (const audience of ["seller", "customer"] as const) {
  test(`${audience} sign-in email preserves escaped account and URL values`, async () => {
    const to = `owner+<img src=x onerror='alert(1)'>@example.test`;
    const url = `https://accounts.example.test/app/${audience}?next="a"&value='<b>'#login=example_token`;
    const message = signInEmail(to, url, audience);
    const window = new Window();
    try {
      window.document.write(message.html!);
      const document = window.document;
      assert.equal(document.querySelectorAll("img, script, b").length, 0);
      assert.ok(document.body.textContent.includes(to));
      const links = Array.from(document.querySelectorAll("a"));
      assert.equal(links.length, 2);
      for (const link of links) assert.equal(link.getAttribute("href"), url);
      assert.ok(message.text.includes(url));
      assert.ok(message.text.includes(to));
      assert.match(
        document.body.textContent,
        /single-use link expires in 15 minutes/,
      );
      if (audience === "customer") {
        assert.match(document.body.textContent, /customer account/);
        assert.doesNotMatch(
          document.body.textContent,
          /seller dashboard|same browser|latest/,
        );
        assert.doesNotMatch(message.text, /same browser|latest/);
      }
    } finally {
      await window.happyDOM.close();
    }
  });
}
