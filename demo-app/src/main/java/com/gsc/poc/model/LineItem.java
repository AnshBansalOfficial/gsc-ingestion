package com.gsc.poc.model;

/**
 * A single billable line on an invoice.
 *
 * @param description human readable label, e.g. "Support retainer"
 * @param amountCents amount in minor currency units (cents) to avoid floating point money
 */
public record LineItem(String description, int amountCents) {
}
