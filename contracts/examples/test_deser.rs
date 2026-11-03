fn main() {
    let s = r#"{"proposal_id": 1, "code": "AGFzbQEAAAA="}"#;
    #[derive(serde::Deserialize, Debug)]
    struct Args {
        #[allow(dead_code)]
        proposal_id: u64,
        #[allow(dead_code)]
        code: Option<Vec<u8>>,
    }
    let res: Result<Args, _> = serde_json::from_str(s);
    println!("Base64 deser result: {:?}", res);
}
