import { App, Plugin, PluginSettingTab, Setting } from "obsidian";
import * as https from "https";
import * as http from "http";
import forge, { pki } from "node-forge";

import RequestHandler from "./requestHandler";
import { LocalRestApiSettings } from "./types";

import {
  DefaultBearerTokenHeaderName,
  CERT_NAME,
  DEFAULT_SETTINGS,
  DefaultBindingHost,
  LicenseUrl,
} from "./constants";
import {
  getCertificateIsUptoStandards,
  getCertificateValidityDays,
} from "./utils";

export default class LocalRestApi extends Plugin {
  settings: LocalRestApiSettings;
  secureServer: https.Server | null = null;
  insecureServer: http.Server | null = null;
  requestHandler: RequestHandler;
  refreshServerState: () => void;

  async onload() {
    this.refreshServerState = this.debounce(
      this._refreshServerState.bind(this),
      1000
    );

    await this.loadSettings();
    this.requestHandler = new RequestHandler(
      this.app,
      this.manifest,
      this.settings
    );
    this.requestHandler.setupRouter();

    if (!this.settings.apiKey) {
      this.settings.apiKey = forge.md.sha256
        .create()
        .update(forge.random.getBytesSync(128))
        .digest()
        .toHex();
      this.saveSettings();
    }
    if (!this.settings.crypto) {
      const expiry = new Date();
      const today = new Date();
      expiry.setDate(today.getDate() + 365);

      const keypair = forge.pki.rsa.generateKeyPair(2048);
      const attrs = [
        {
          name: "commonName",
          value: "Obsidian Local REST",
        },
      ];
      const certificate = forge.pki.createCertificate();
      certificate.setIssuer(attrs);
      certificate.setSubject(attrs);

      const subjectAltNames: Record<string, any>[] = [
        {
          type: 7, // IP
          ip: DefaultBindingHost,
        },
      ];
      if (
        this.settings.bindingHost &&
        this.settings.bindingHost !== "0.0.0.0"
      ) {
        subjectAltNames.push({
          type: 7, // IP
          ip: this.settings.bindingHost,
        });
      }
      if (this.settings.subjectAltNames) {
        for (const name of this.settings.subjectAltNames.split("\n")) {
          if (name.trim()) {
            subjectAltNames.push({
              type: 2,
              value: name.trim(),
            });
          }
        }
      }

      certificate.setExtensions([
        {
          name: "basicConstraints",
          cA: true,
          critical: true,
        },
        {
          name: "keyUsage",
          keyCertSign: true,
          digitalSignature: true,
          nonRepudiation: true,
          keyEncipherment: false,
          dataEncipherment: false,
          critical: true,
        },
        {
          name: "extKeyUsage",
          serverAuth: true,
          clientAuth: true,
          codeSigning: true,
          emailProtection: true,
          timeStamping: true,
        },
        {
          name: "nsCertType",
          client: true,
          server: true,
          email: true,
          objsign: true,
          sslCA: true,
          emailCA: true,
          objCA: true,
        },
        {
          name: "subjectAltName",
          altNames: subjectAltNames,
        },
      ]);
      certificate.serialNumber = "1";
      certificate.publicKey = keypair.publicKey;
      certificate.validity.notAfter = expiry;
      certificate.validity.notBefore = today;
      certificate.sign(keypair.privateKey, forge.md.sha256.create());

      this.settings.crypto = {
        cert: pki.certificateToPem(certificate),
        privateKey: pki.privateKeyToPem(keypair.privateKey),
        publicKey: pki.publicKeyToPem(keypair.publicKey),
      };
      this.saveSettings();
    }

    this.addSettingTab(new LocalRestApiSettingTab(this.app, this));

    this.refreshServerState();
  }

  debounce<F extends (...args: any[]) => any>(
    func: F,
    delay: number
  ): (...args: Parameters<F>) => void {
    let debounceTimer: NodeJS.Timeout;
    return (...args: Parameters<F>): void => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => func(...args), delay);
    };
  }

  _refreshServerState() {
    if (this.secureServer) {
      this.secureServer.close();
      this.secureServer = null;
    }
    this.secureServer = https.createServer(
      { key: this.settings.crypto.privateKey, cert: this.settings.crypto.cert },
      this.requestHandler.api
    );
    this.secureServer.listen(
      this.settings.port,
      this.settings.bindingHost ?? DefaultBindingHost
    );

    console.log(
      `[REST API] Listening on https://${this.settings.bindingHost ?? DefaultBindingHost
      }:${this.settings.port}/`
    );

    if (this.insecureServer) {
      this.insecureServer.close();
      this.insecureServer = null;
    }
    if (this.settings.enableInsecureServer) {
      this.insecureServer = http.createServer(this.requestHandler.api);
      this.insecureServer.listen(
        this.settings.insecurePort,
        this.settings.bindingHost ?? DefaultBindingHost
      );

      console.log(
        `[REST API] Listening on http://${this.settings.bindingHost ?? DefaultBindingHost
        }:${this.settings.insecurePort}/`
      );
    }
  }

  onunload() {
    if (this.secureServer) {
      this.secureServer.close();
    }
    if (this.insecureServer) {
      this.insecureServer.close();
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class LocalRestApiSettingTab extends PluginSettingTab {
  plugin: LocalRestApi;
  showAdvancedSettings = false;

  constructor(app: App, plugin: LocalRestApi) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    const parsedCertificate = forge.pki.certificateFromPem(
      this.plugin.settings.crypto.cert
    );
    const remainingCertificateValidityDays =
      getCertificateValidityDays(parsedCertificate);
    const shouldRegenerateCertificate =
      !getCertificateIsUptoStandards(parsedCertificate);

    containerEl.empty();
    containerEl.classList.add("obsidian-local-rest-api-settings");

    const apiKeyDiv = containerEl.createEl("div");
    apiKeyDiv.classList.add("api-key-display");

    apiKeyDiv.createEl("h3", { text: "Your API Key" });
    apiKeyDiv.createEl("p", {
      text: "This must be passed in all requests via an authorization header.",
    });
    apiKeyDiv.createEl("pre", { text: this.plugin.settings.apiKey });
    apiKeyDiv.createEl("p", { text: "Example header: " });
    apiKeyDiv.createEl("pre", {
      text: `${this.plugin.settings.authorizationHeaderName ?? "Authorization"
        }: Bearer ${this.plugin.settings.apiKey}`,
    });

    const seeMore = apiKeyDiv.createEl("p");
    seeMore.createEl("a", {
      href: "https://coddingtonbear.github.io/obsidian-local-rest-api/",
      text: "See more information and examples in our interactive OpenAPI documentation.",
    });

    const importCert = apiKeyDiv.createEl("p");
    importCert.createEl("span", {
      text: "By default this plugin uses a self-signed certificate for HTTPS; you may want to ",
    });
    importCert.createEl("a", {
      href: `https://127.0.0.1:${this.plugin.settings.port}/${CERT_NAME}`,
      text: "download this certificate",
    });
    importCert.createEl("span", {
      text: " to use it for validating your connection's security by adding it as a trusted certificate authority in the browser or tool you are using for interacting with this API.",
    });

    if (remainingCertificateValidityDays < 0) {
      const expiredCertDiv = apiKeyDiv.createEl("div");
      expiredCertDiv.classList.add("certificate-expired");
      expiredCertDiv.innerHTML = `
        <b>Your certificate has expired!</b>
        You must re-generate your certificate below by pressing
        the "Re-generate Certificates" button below in
        order to connect securely to this API.
      `;
    } else if (remainingCertificateValidityDays < 30) {
      const soonExpiringCertDiv = apiKeyDiv.createEl("div");
      soonExpiringCertDiv.classList.add("certificate-expiring-soon");
      soonExpiringCertDiv.innerHTML = `
        <b>Your certificate will expire in ${Math.floor(
        remainingCertificateValidityDays
      )} day${Math.floor(remainingCertificateValidityDays) === 1 ? "" : "s"
        }s!</b>
        You should re-generate your certificate below by pressing
        the "Re-generate Certificates" button below in
        order to continue to connect securely to this API.
      `;
    }
    if (shouldRegenerateCertificate) {
      const shouldRegenerateCertificateDiv = apiKeyDiv.createEl("div");
      shouldRegenerateCertificateDiv.classList.add(
        "certificate-regeneration-recommended"
      );
      shouldRegenerateCertificateDiv.innerHTML = `
        <b>You should re-generate your certificate!</b>
        Your certificate was generated using earlier standards than
        are currently used by Obsidian Local REST API. Some systems
        or tools may not accept your certificate with its current
        configuration, and re-generating your certificate may
        improve compatibility with such tools.  To re-generate your
        certificate, press the "Re-generate Certificates" button
        below.
      `;
    }

    new Setting(containerEl)
      .setName("Enable Non-encrypted (HTTP) Server")
      .setDesc(
        "Enables a non-encrypted (HTTP) server on the port designated below.  By default this plugin requires a secure HTTPS connection, but in safe environments you may turn on the non-encrypted server to simplify interacting with the API. Interactions with the API will still require the API Key shown above.  Under no circumstances is it recommended that you expose this service to the internet, especially if you turn on this feature!"
      )
      .addToggle((cb) =>
        cb
          .onChange((value) => {
            this.plugin.settings.enableInsecureServer = value;
            this.plugin.saveSettings();
            this.plugin.refreshServerState();
          })
          .setValue(this.plugin.settings.enableInsecureServer)
      );

    new Setting(containerEl)
      .setName("Reset All Cryptography")
      .setDesc(
        `Pressing this button will cause your certificate,
        private key, public key, and API key to be regenerated.
        This settings panel will be closed when you press this.`
      )
      .addButton((cb) => {
        cb.setWarning()
          .setButtonText("Reset All Crypto")
          .onClick(() => {
            delete this.plugin.settings.apiKey;
            delete this.plugin.settings.crypto;
            this.plugin.saveSettings();
            this.plugin.unload();
            this.plugin.load();
          });
      });

    new Setting(containerEl)
      .setName("Re-generate Certificates")
      .setDesc(
        `Pressing this button will cause your certificate,
        private key,  and public key to be re-generated, but your API key will remain unchanged. 
        This settings panel will be closed when you press this.`
      )
      .addButton((cb) => {
        cb.setWarning()
          .setButtonText("Re-generate Certificates")
          .onClick(() => {
            delete this.plugin.settings.crypto;
            this.plugin.saveSettings();
            this.plugin.unload();
            this.plugin.load();
          });
      });

    new Setting(containerEl)
      .setName("Restore Default Settings")
      .setDesc(
        `Pressing this button will reset this plugin's
        settings to defaults.
        This settings panel will be closed when you press this.`
      )
      .addButton((cb) => {
        cb.setWarning()
          .setButtonText("Restore Defaults")
          .onClick(() => {
            this.plugin.settings = Object.assign({}, DEFAULT_SETTINGS);
            this.plugin.saveSettings();
            this.plugin.unload();
            this.plugin.load();
          });
      });

    new Setting(containerEl)
      .setName("Show advanced settings")
      .setDesc(
        `Advanced settings are dangerous and may make your environment less secure.`
      )
      .addToggle((cb) => {
        cb.onChange((value) => {
          if (this.showAdvancedSettings !== value) {
            this.showAdvancedSettings = value;
            this.display();
          }
        }).setValue(this.showAdvancedSettings);
      });

    if (this.showAdvancedSettings) {
      containerEl.createEl("hr");
      containerEl.createEl("h3", {
        text: "Advanced Settings",
      });
      containerEl.createEl("p", {
        text: `
          The settings below are potentially dangerous and
          are intended for use only by people who know what
          they are doing. Do not change any of these settings if
          you do not understand what that setting is used for
          and what security impacts changing that setting will have.
        `,
      });
      const noWarrantee = containerEl.createEl("p");
      noWarrantee.createEl("span", {
        text: `
          Use of this software is licensed to you under the
          MIT license, and it is important that you understand that 
          this license provides you with no warranty.
          For the complete license text please see
        `,
      });
      noWarrantee.createEl("a", {
        href: LicenseUrl,
        text: LicenseUrl,
      });
      noWarrantee.createEl("span", { text: "." });

      new Setting(containerEl)
        .setName("Encrypted (HTTPS) Server Port")
        .setDesc(
          "This configures the port on which your REST API will listen for HTTPS connections.  It is recommended that you leave this port with its default setting as tools integrating with this API may expect the default port to be in use.  Under no circumstances is it recommended that you expose this service directly to the internet."
        )
        .addText((cb) =>
          cb
            .onChange((value) => {
              this.plugin.settings.port = parseInt(value, 10);
              this.plugin.saveSettings();
              this.plugin.refreshServerState();
            })
            .setValue(this.plugin.settings.port.toString())
        );

      new Setting(containerEl)
        .setName("Non-encrypted (HTTP) Server Port")
        .addText((cb) =>
          cb
            .onChange((value) => {
              this.plugin.settings.insecurePort = parseInt(value, 10);
              this.plugin.saveSettings();
              this.plugin.refreshServerState();
            })
            .setValue(this.plugin.settings.insecurePort.toString())
        );

      new Setting(containerEl).setName("API Key").addText((cb) => {
        cb.onChange((value) => {
          this.plugin.settings.apiKey = value;
          this.plugin.saveSettings();
          this.plugin.refreshServerState();
        }).setValue(this.plugin.settings.apiKey);
      });
      new Setting(containerEl)
        .setName("Certificate Hostnames")
        .setDesc(
          `
          List of extra hostnames to add
          to your certificate's \`subjectAltName\` field.
          One hostname per line.
          You must click the "Re-generate Certificates" button above after changing this value
          for this to have an effect.  This is useful for
          situations in which you are accessing Obsidian
          from a hostname other than the host on which
          it is running.
      `
        )
        .addTextArea((cb) =>
          cb
            .onChange((value) => {
              this.plugin.settings.subjectAltNames = value;
              this.plugin.saveSettings();
            })
            .setValue(this.plugin.settings.subjectAltNames)
        );
      new Setting(containerEl).setName("Certificate").addTextArea((cb) =>
        cb
          .onChange((value) => {
            this.plugin.settings.crypto.cert = value;
            this.plugin.saveSettings();
            this.plugin.refreshServerState();
          })
          .setValue(this.plugin.settings.crypto.cert)
      );
      new Setting(containerEl).setName("Public Key").addTextArea((cb) =>
        cb
          .onChange((value) => {
            this.plugin.settings.crypto.publicKey = value;
            this.plugin.saveSettings();
            this.plugin.refreshServerState();
          })
          .setValue(this.plugin.settings.crypto.publicKey)
      );
      new Setting(containerEl).setName("Private Key").addTextArea((cb) =>
        cb
          .onChange((value) => {
            this.plugin.settings.crypto.privateKey = value;
            this.plugin.saveSettings();
            this.plugin.refreshServerState();
          })
          .setValue(this.plugin.settings.crypto.privateKey)
      );
      new Setting(containerEl).setName("Authorization Header").addText((cb) => {
        cb.onChange((value) => {
          if (value !== DefaultBearerTokenHeaderName) {
            this.plugin.settings.authorizationHeaderName = value;
          } else {
            delete this.plugin.settings.authorizationHeaderName;
          }
          this.plugin.saveSettings();
          this.plugin.refreshServerState();
        }).setValue(
          this.plugin.settings.authorizationHeaderName ??
          DefaultBearerTokenHeaderName
        );
      });
      new Setting(containerEl).setName("Binding Host").addText((cb) => {
        cb.onChange((value) => {
          if (value !== DefaultBindingHost) {
            this.plugin.settings.bindingHost = value;
          } else {
            delete this.plugin.settings.bindingHost;
          }
          this.plugin.saveSettings();
          this.plugin.refreshServerState();
        }).setValue(this.plugin.settings.bindingHost ?? DefaultBindingHost);
      });
    }
  }
}
