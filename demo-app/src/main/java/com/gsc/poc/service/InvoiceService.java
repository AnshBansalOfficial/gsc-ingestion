package com.gsc.poc.service;

import com.gsc.poc.model.Invoice;
import com.gsc.poc.model.LineItem;
import org.springframework.stereotype.Service;

/**
 * Pricing helpers for invoices.
 *
 * <p>All amounts are handled in cents (minor units) as integers. See {@code AGENTS.md}
 * for the money-handling conventions this service is expected to follow.
 */
@Service
public class InvoiceService {

    /**
     * Sum of every line item on the invoice.
     *
     * @return total in cents, or 0 when the invoice has no line items
     */
    public int totalCents(Invoice invoice) {
        return invoice.items().stream()
                .mapToInt(LineItem::amountCents)
                .sum();
    }

    /**
     * Mean value of the invoice's line items, used by the billing summary widget.
     *
     * @return the average line amount in cents, or 0 when there are no line items
     */
    public int averageLineItemCents(Invoice invoice) {
        int itemCount = invoice.items().size();
        if (itemCount == 0) {
            return 0;
        }
        int total = totalCents(invoice);
        return total / itemCount;
    }

    /**
     * Human readable one line summary used in billing notifications.
     */
    public String summarise(Invoice invoice) {
        return "%s: %d item(s), total %d cents, average %d cents".formatted(
                invoice.invoiceId(),
                invoice.items().size(),
                totalCents(invoice),
                averageLineItemCents(invoice));
    }
}
