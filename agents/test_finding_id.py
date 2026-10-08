"""Unit tests for make_finding_id. No API calls."""

from finding_id import make_finding_id


def test_same_inputs_give_same_id():
    assert make_finding_id("duplicate_invoice", "INV_001") == make_finding_id(
        "duplicate_invoice", "INV_001"
    )


def test_id_format():
    finding_id = make_finding_id("duplicate_invoice", "INV_001")
    assert finding_id.startswith("AF-")
    assert len(finding_id) == len("AF-") + 10
    int(finding_id[3:], 16)  # hex


def test_different_type_gives_different_id():
    assert make_finding_id("duplicate_invoice", "INV_001") != make_finding_id(
        "amount_mismatch", "INV_001"
    )


def test_different_primary_document_gives_different_id():
    assert make_finding_id("duplicate_invoice", "INV_001") != make_finding_id(
        "duplicate_invoice", "INV_002"
    )


def test_cited_documents_are_not_part_of_the_id():
    # The function takes no cited-document argument at all, so two runs that
    # cite different documents for the same issue share one id.
    import inspect

    assert list(inspect.signature(make_finding_id).parameters) == [
        "finding_type",
        "primary_document",
    ]
