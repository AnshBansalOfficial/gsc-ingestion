package com.gsc.poc.model;

import java.util.List;

/**
 * An invoice for a single customer.
 *
 * <p>An invoice may legitimately have zero line items — for example a draft invoice that
 * has been created but not yet populated. Pricing helpers must therefore tolerate an
 * empty {@code items} list.
 *
 * @param invoiceId external identifier, e.g. "INV-1042"
 * @param items     the billable lines; may be empty, never null
 */
public record Invoice(String invoiceId, List<LineItem> items) {
}
