import { site } from "./site.ts";
import type { Message } from "./email.ts";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character]!;
  });
}

/** One email body for both login flows; browser binding applies only to sellers. */
export function signInEmail(
  to: string,
  url: string,
  audience: "seller" | "customer",
): Omit<Message, "messageId"> {
  const seller = audience === "seller";
  const destination = seller
    ? "your seller dashboard"
    : "your customer account";
  const instructions = seller
    ? "Open this link in the same browser where you requested it. If you requested more than one email, use your latest sign-in link."
    : "Open this link in your browser to continue.";
  const expiry = "This single-use link expires in 15 minutes.";
  const ignore = "If you didn’t request this email, you can safely ignore it.";
  const safeUrl = escapeHtml(url);
  const name = escapeHtml(site.name);

  return {
    to,
    subject: `Sign in to ${site.name}`,
    text: `Sign in to ${site.name}\n\nContinue to ${destination}.\nSigning in as: ${to}\n\nOpen ${url}\n\n${instructions}\n${expiry}\n\n${ignore}`,
    html: `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="format-detection" content="telephone=no, date=no, address=no, email=no">
  <title>Sign in to ${name}</title>
  <style>
    a:focus-visible { outline: 3px solid #a97726; outline-offset: 4px; }
    .sign-in:hover { background-color: #173b32 !important; }
    @media only screen and (max-width: 600px) {
      .email-shell { padding: 28px 16px !important; }
      .email-content { padding: 28px 24px !important; }
      .email-title { font-size: 30px !important; line-height: 36px !important; }
    }
  </style>
</head>
<body style="margin: 0; padding: 0; width: 100%; background-color: #f6f7f4; color: #1d302d; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%;">
  <div style="display: none; font-size: 1px; line-height: 1px; max-height: 0; max-width: 0; opacity: 0; overflow: hidden; mso-hide: all;">Your sign-in link for ${name}. Expires in 15 minutes.${seller ? " Open in the same browser where you requested it." : ""}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#f6f7f4" style="width: 100%; border-collapse: collapse;">
    <tr>
      <td class="email-shell" align="center" style="padding: 44px 24px;">
        <!--[if mso]><table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0"><tr><td><![endif]-->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width: 100%; max-width: 560px; border-collapse: collapse; font-family: Arial, Helvetica, sans-serif;">
          <tr>
            <td style="padding: 0 0 24px; color: #205843; font-size: 20px; line-height: 28px; font-weight: 700; letter-spacing: -0.5px;">${name}</td>
          </tr>
          <tr>
            <td bgcolor="#ffffff" style="background-color: #ffffff; border: 1px solid #dce3dd; border-top: 4px solid #205843; border-radius: 12px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width: 100%; table-layout: fixed; border-collapse: collapse;">
                <tr>
                  <td class="email-content" style="padding: 36px 40px;">
                    <p style="margin: 0 0 16px; color: #286551; font-size: 11px; line-height: 16px; font-weight: 700; letter-spacing: 1.8px; text-transform: uppercase;">Account access</p>
                    <h1 class="email-title" style="margin: 0 0 16px; color: #173b32; font-family: Georgia, 'Times New Roman', serif; font-size: 36px; line-height: 42px; font-weight: 400; letter-spacing: -0.8px;">Your sign-in link is ready.</h1>
                    <p style="margin: 0 0 24px; color: #5c6e66; font-size: 16px; line-height: 26px;">Continue to ${destination}.</p>
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width: 100%; table-layout: fixed; border-collapse: collapse;">
                      <tr>
                        <td bgcolor="#f1f5ef" style="padding: 16px 20px; background-color: #f1f5ef; border-radius: 8px;">
                          <p style="margin: 0 0 4px; color: #5c6e66; font-size: 11px; line-height: 16px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase;">Signing in as</p>
                          <p style="margin: 0; color: #1d302d; font-size: 15px; line-height: 24px; font-weight: 600; overflow-wrap: anywhere; word-break: break-all;">${escapeHtml(to)}</p>
                        </td>
                      </tr>
                    </table>
                    <p style="margin: 24px 0; color: #42584c; font-size: 14px; line-height: 23px;">${instructions}</p>
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width: 100%; border-collapse: collapse;">
                      <tr>
                        <td align="center" bgcolor="#205843" style="background-color: #205843; border-radius: 8px; mso-padding-alt: 16px 24px;">
                          <a class="sign-in" href="${safeUrl}" style="display: block; padding: 16px 24px; border: 1px solid #205843; border-radius: 8px; color: #ffffff; background-color: #205843; font-family: Arial, Helvetica, sans-serif; font-size: 16px; line-height: 22px; font-weight: 700; text-align: center; text-decoration: none; mso-padding-alt: 0;">Sign in to Entitle</a>
                        </td>
                      </tr>
                    </table>
                    <p style="margin: 12px 0 28px; color: #5c6e66; font-size: 12px; line-height: 20px; text-align: center;">${expiry}</p>
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width: 100%; table-layout: fixed; border-collapse: collapse;">
                      <tr>
                        <td style="border-top: 1px solid #e4e9e2; padding-top: 24px;">
                          <p style="margin: 0 0 8px; color: #5c6e66; font-size: 12px; line-height: 20px;">Button not working? Copy and paste this link into ${seller ? "the same" : "your"} browser:</p>
                          <a href="${safeUrl}" style="color: #286551; font-size: 12px; line-height: 20px; text-decoration: underline; overflow-wrap: anywhere; word-break: break-all;">${safeUrl}</a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding: 24px 8px 0; color: #5c6e66; font-size: 12px; line-height: 20px; text-align: center;">${ignore}</td>
          </tr>
        </table>
        <!--[if mso]></td></tr></table><![endif]-->
      </td>
    </tr>
  </table>
</body>
</html>`,
  };
}
