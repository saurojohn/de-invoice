#!/usr/bin/env python3
"""
Insert the 'webhooks' top-level section into all 3 locale files.
Run from frontend/ directory.
"""
import json
import sys

WEBHOOKS = {
    "webhooks": {
        "title": {
            "de": "Webhooks",
            "en": "Webhooks",
            "zh": "Webhooks",
        },
        "subtitle": {
            "de": "HTTP-Callbacks, die bei Geschäftsereignissen automatisch ausgelöst werden. Ideal für DATEV, sevDesk, Zapier, Make oder eigene interne Systeme.",
            "en": "HTTP callbacks fired automatically on business events. Ideal for DATEV, sevDesk, Zapier, Make, or your own internal systems.",
            "zh": "在业务事件触发时自动发送的 HTTP 回调,适合集成 DATEV、sevDesk、Zapier、Make 或自有内部系统。",
        },
        "create": {
            "de": "Webhook hinzufügen",
            "en": "Add webhook",
            "zh": "添加 Webhook",
        },
        "createTitle": {
            "de": "Neuen Webhook anlegen",
            "en": "Create new webhook",
            "zh": "新建 Webhook",
        },
        "name": {
            "de": "Name",
            "en": "Name",
            "zh": "名称",
        },
        "namePlaceholder": {
            "de": "z. B. DATEV-Connector",
            "en": "e.g. DATEV connector",
            "zh": "例如:DATEV 连接器",
        },
        "url": {
            "de": "Empfänger-URL",
            "en": "Receiver URL",
            "zh": "接收 URL",
        },
        "urlPlaceholder": {
            "de": "https://example.com/webhook",
            "en": "https://example.com/webhook",
            "zh": "https://example.com/webhook",
        },
        "urlHelp": {
            "de": "Wir senden POST-Requests an diese URL. Privater Speicherplatz (10.x, 192.168.x) und Localhost sind nicht erlaubt.",
            "en": "We send POST requests to this URL. Private ranges (10.x, 192.168.x) and localhost are not allowed.",
            "zh": "我们会向此 URL 发送 POST 请求。不允许使用内网段(10.x、192.168.x)或 localhost。",
        },
        "events": {
            "de": "Ereignisse",
            "en": "Events",
            "zh": "事件",
        },
        "eventsHelp": {
            "de": "Wählen Sie die Ereignisse, bei denen der Webhook ausgelöst werden soll.",
            "en": "Select the events that should trigger the webhook.",
            "zh": "选择需要触发此 Webhook 的事件。",
        },
        "description": {
            "de": "Beschreibung (optional)",
            "en": "Description (optional)",
            "zh": "描述(可选)",
        },
        "secretTitle": {
            "de": "Webhook-Geheimnis",
            "en": "Webhook secret",
            "zh": "Webhook 密钥",
        },
        "secretBody": {
            "de": "Speichern Sie dieses Geheimnis jetzt — wir zeigen es aus Sicherheitsgründen nicht erneut. Verwenden Sie es auf der Empfängerseite, um die X-Signature-Header zu verifizieren.",
            "en": "Save this secret now — we will not show it again for security reasons. Use it on the receiver side to verify the X-Signature header.",
            "zh": "请立即保存此密钥 — 出于安全考虑,我们将不再显示。请在接收端使用它验证 X-Signature 头。",
        },
        "secretCopied": {
            "de": "In die Zwischenablage kopiert",
            "en": "Copied to clipboard",
            "zh": "已复制到剪贴板",
        },
        "empty": {
            "de": "Noch keine Webhooks konfiguriert. Klicken Sie auf „Webhook hinzufügen\", um Ihren ersten Empfänger einzurichten.",
            "en": "No webhooks configured yet. Click \"Add webhook\" to set up your first receiver.",
            "zh": "尚未配置 Webhook。点击「添加 Webhook」设置第一个接收端。",
        },
        "status": {
            "active": {
                "de": "Aktiv",
                "en": "Active",
                "zh": "已启用",
            },
            "paused": {
                "de": "Pausiert",
                "en": "Paused",
                "zh": "已暂停",
            },
            "disabled": {
                "de": "Deaktiviert",
                "en": "Disabled",
                "zh": "已停用",
            },
        },
        "actions": {
            "test": {
                "de": "Test senden",
                "en": "Send test",
                "zh": "发送测试",
            },
            "deliveries": {
                "de": "Zustellungen",
                "en": "Deliveries",
                "zh": "投递历史",
            },
            "pause": {
                "de": "Pausieren",
                "en": "Pause",
                "zh": "暂停",
            },
            "resume": {
                "de": "Fortsetzen",
                "en": "Resume",
                "zh": "继续",
            },
            "delete": {
                "de": "Löschen",
                "en": "Delete",
                "zh": "删除",
            },
        },
        "deleteConfirm": {
            "de": "Diesen Webhook wirklich löschen? Die Zustell-Historie bleibt für die Audit-Zwecke erhalten.",
            "en": "Really delete this webhook? Delivery history will be kept for audit purposes.",
            "zh": "确定要删除此 Webhook 吗?投递历史将保留用于审计。",
        },
        "testSent": {
            "de": "Test-Ereignis gesendet. Prüfen Sie die Empfänger-Seite und die Zustell-Historie.",
            "en": "Test event sent. Check the receiver and the delivery history.",
            "zh": "已发送测试事件。请检查接收端和投递历史。",
        },
        "deliveries": {
            "title": {
                "de": "Zustell-Historie",
                "en": "Delivery history",
                "zh": "投递历史",
            },
            "empty": {
                "de": "Noch keine Zustellungen.",
                "en": "No deliveries yet.",
                "zh": "尚无投递记录。",
            },
            "status": {
                "success": {
                    "de": "Erfolg",
                    "en": "Success",
                    "zh": "成功",
                },
                "failed": {
                    "de": "Fehlgeschlagen",
                    "en": "Failed",
                    "zh": "失败",
                },
                "exhausted": {
                    "de": "Aufgegeben",
                    "en": "Exhausted",
                    "zh": "已耗尽",
                },
                "pending": {
                    "de": "Läuft",
                    "en": "Pending",
                    "zh": "进行中",
                },
            },
            "eventType": {
                "de": "Ereignis",
                "en": "Event",
                "zh": "事件",
            },
            "statusCode": {
                "de": "HTTP-Status",
                "en": "HTTP status",
                "zh": "HTTP 状态",
            },
            "duration": {
                "de": "Dauer",
                "en": "Duration",
                "zh": "耗时",
            },
            "attemptedAt": {
                "de": "Versucht am",
                "en": "Attempted at",
                "zh": "尝试时间",
            },
            "nextRetry": {
                "de": "Nächster Versuch",
                "en": "Next retry",
                "zh": "下次重试",
            },
            "noRetry": {
                "de": "—",
                "en": "—",
                "zh": "—",
            },
        },
        "eventsList": {
            "invoiceCreated": {
                "label": {
                    "de": "Rechnung erstellt",
                    "en": "Invoice created",
                    "zh": "发票已创建",
                },
                "description": {
                    "de": "Wird ausgelöst, sobald eine neue Rechnung gespeichert wird.",
                    "en": "Fired when a new invoice is saved.",
                    "zh": "新发票保存时触发。",
                },
            },
            "invoiceUpdated": {
                "label": {
                    "de": "Rechnung geändert",
                    "en": "Invoice updated",
                    "zh": "发票已更新",
                },
                "description": {
                    "de": "Status- oder Feldänderungen an einer bestehenden Rechnung.",
                    "en": "Status or field changes on an existing invoice.",
                    "zh": "现有发票的状态或字段变化。",
                },
            },
            "invoicePaid": {
                "label": {
                    "de": "Rechnung bezahlt",
                    "en": "Invoice paid",
                    "zh": "发票已付清",
                },
                "description": {
                    "de": "Wird ausgelöst, wenn eine Rechnung den Status „bezahlt\" erhält.",
                    "en": "Fired when an invoice transitions to the \"paid\" status.",
                    "zh": "发票状态变为「已付清」时触发。",
                },
            },
            "invoiceSent": {
                "label": {
                    "de": "Rechnung versendet",
                    "en": "Invoice sent",
                    "zh": "发票已发送",
                },
                "description": {
                    "de": "Wird ausgelöst, wenn eine Rechnung an den Kunden gesendet wird.",
                    "en": "Fired when an invoice is sent to the customer.",
                    "zh": "发票发送给客户时触发。",
                },
            },
            "invoiceDeleted": {
                "label": {
                    "de": "Rechnung gelöscht",
                    "en": "Invoice deleted",
                    "zh": "发票已删除",
                },
                "description": {
                    "de": "Wird ausgelöst, wenn eine Rechnung am Ausstellungstag gelöscht wird.",
                    "en": "Fired when an invoice is deleted on its issue date.",
                    "zh": "发票在出票日被删除时触发。",
                },
            },
            "paymentReceived": {
                "label": {
                    "de": "Zahlung erhalten",
                    "en": "Payment received",
                    "zh": "收到付款",
                },
                "description": {
                    "de": "Wird ausgelöst, sobald eine Zahlung gegen eine Rechnung erfasst wird.",
                    "en": "Fired when a payment is recorded against an invoice.",
                    "zh": "对发票进行付款记录时触发。",
                },
            },
            "voucherCreated": {
                "label": {
                    "de": "Beleg erstellt",
                    "en": "Voucher created",
                    "zh": "凭证已创建",
                },
                "description": {
                    "de": "Wird ausgelöst, sobald ein neuer Beleg (Buchung) gespeichert wird.",
                    "en": "Fired when a new voucher (booking) is saved.",
                    "zh": "新凭证(记账)保存时触发。",
                },
            },
            "voucherPosted": {
                "label": {
                    "de": "Beleg gebucht",
                    "en": "Voucher posted",
                    "zh": "凭证已记账",
                },
                "description": {
                    "de": "Wird ausgelöst, wenn ein Beleg endgültig gebucht wird.",
                    "en": "Fired when a voucher is finally posted.",
                    "zh": "凭证最终记账时触发。",
                },
            },
            "voucherReversed": {
                "label": {
                    "de": "Beleg storniert",
                    "en": "Voucher reversed",
                    "zh": "凭证已冲销",
                },
                "description": {
                    "de": "Wird ausgelöst, wenn ein Beleg storniert (GoBD-konform) wird.",
                    "en": "Fired when a voucher is reversed (GoBD-compliant).",
                    "zh": "凭证冲销(符合 GoBD)时触发。",
                },
            },
            "customerCreated": {
                "label": {
                    "de": "Kunde angelegt",
                    "en": "Customer created",
                    "zh": "客户已创建",
                },
                "description": {
                    "de": "Wird ausgelöst, sobald ein neuer Kunde gespeichert wird.",
                    "en": "Fired when a new customer is saved.",
                    "zh": "新客户保存时触发。",
                },
            },
            "customerUpdated": {
                "label": {
                    "de": "Kunde geändert",
                    "en": "Customer updated",
                    "zh": "客户已更新",
                },
                "description": {
                    "de": "Wird ausgelöst, wenn ein bestehender Kunde geändert wird.",
                    "en": "Fired when an existing customer is updated.",
                    "zh": "现有客户被修改时触发。",
                },
            },
            "companyUpdated": {
                "label": {
                    "de": "Unternehmen geändert",
                    "en": "Company updated",
                    "zh": "公司已更新",
                },
                "description": {
                    "de": "Wird ausgelöst, wenn die Stammdaten des Unternehmens geändert werden.",
                    "en": "Fired when company master data is changed.",
                    "zh": "公司主数据被修改时触发。",
                },
            },
        },
        "errors": {
            "loadFailed": {
                "de": "Webhooks konnten nicht geladen werden.",
                "en": "Failed to load webhooks.",
                "zh": "加载 Webhook 失败。",
            },
            "createFailed": {
                "de": "Webhook konnte nicht erstellt werden.",
                "en": "Failed to create webhook.",
                "zh": "创建 Webhook 失败。",
            },
            "updateFailed": {
                "de": "Webhook konnte nicht aktualisiert werden.",
                "en": "Failed to update webhook.",
                "zh": "更新 Webhook 失败。",
            },
            "deleteFailed": {
                "de": "Webhook konnte nicht gelöscht werden.",
                "en": "Failed to delete webhook.",
                "zh": "删除 Webhook 失败。",
            },
            "testFailed": {
                "de": "Test-Ereignis konnte nicht gesendet werden.",
                "en": "Failed to send test event.",
                "zh": "发送测试事件失败。",
            },
        },
        "info": {
            "signature": {
                "de": "Jede Anfrage enthält den Header X-Signature: sha256=<hex>, wobei <hex> ein HMAC-SHA256 des Anfrage-Bodys mit Ihrem Geheimnis als Schlüssel ist.",
                "en": "Each request includes the X-Signature: sha256=<hex> header, where <hex> is an HMAC-SHA256 of the request body using your secret as the key.",
                "zh": "每个请求都会带上 X-Signature: sha256=<hex> 头,其中 <hex> 是以您的密钥为密钥对请求体的 HMAC-SHA256 签名。",
            },
            "retry": {
                "de": "Bei 5xx- oder Netzwerkfehlern wird der Webhook bis zu dreimal mit exponentiellem Backoff (1 Min, 5 Min, 30 Min) wiederholt. 4xx-Antworten werden nicht wiederholt.",
                "en": "On 5xx or network errors, the webhook is retried up to 3 times with exponential backoff (1m, 5m, 30m). 4xx responses are not retried.",
                "zh": "遇到 5xx 或网络错误时,Webhook 将以指数退避(1 分、5 分、30 分)重试最多 3 次。4xx 响应不会重试。",
            },
        },
        "backToSettings": {
            "de": "Zurück zu Einstellungen",
            "en": "Back to settings",
            "zh": "返回设置",
        },
    }
}


def main():
    for locale, fname in [("de", "de.json"), ("en", "en.json"), ("zh", "zh.json")]:
        path = f"messages/{fname}"
        with open(path) as f:
            data = json.load(f)
        # Build the locale-specific section: take the leaf strings
        # whose value is `{de,en,zh}` and pick the matching one.
        new_section = {}
        for key, value in WEBHOOKS["webhooks"].items():
            if isinstance(value, dict) and locale in value and isinstance(value[locale], str):
                new_section[key] = value[locale]
            elif isinstance(value, dict) and "de" in value and isinstance(value["de"], str):
                new_section[key] = value["de"]
            elif isinstance(value, dict):
                # Nested dict (e.g. status.active), recurse
                new_section[key] = {}
                for k2, v2 in value.items():
                    if isinstance(v2, dict) and locale in v2 and isinstance(v2[locale], str):
                        new_section[key][k2] = v2[locale]
                    elif isinstance(v2, dict) and "de" in v2 and isinstance(v2["de"], str):
                        new_section[key][k2] = v2["de"]
                    else:
                        new_section[key][k2] = v2
        data["webhooks"] = new_section
        with open(path, "w") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print(f"✓ {path} updated ({len(new_section)} keys)")


if __name__ == "__main__":
    main()
