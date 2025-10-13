use serde::{Deserialize, Serialize};

// CvrExport.json file.

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct CvrExport {
    version: String,
    election_id: String,
    pub sessions: Vec<Session>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct Session {
    pub tabulator_id: u32,
    pub batch_id: u32,
    #[serde(deserialize_with = "deserialize_record_id")]
    pub record_id: String,
    pub counting_group_id: u32,
    pub image_mask: String,
    pub original: SessionBallot,
    pub modified: Option<SessionBallot>,
}

fn deserialize_record_id<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::{Error, Visitor};
    use std::fmt;

    struct RecordIdVisitor;

    impl<'de> Visitor<'de> for RecordIdVisitor {
        type Value = String;

        fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
            formatter.write_str("string or integer record id")
        }

        fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
        where
            E: Error,
        {
            Ok(value.to_string())
        }

        fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
        where
            E: Error,
        {
            Ok(value.to_string())
        }
    }

    deserializer.deserialize_any(RecordIdVisitor)
}

impl Session {
    pub fn ballot(&self) -> &SessionBallot {
        if let Some(ballot) = &self.modified {
            ballot
        } else {
            &self.original
        }
    }

    pub fn contests(&self) -> Vec<ContestMarks> {
        match &self.original.contests {
            Some(c) => (*c).clone(),
            None => self
                .ballot()
                .cards
                .as_ref()
                .unwrap()
                .iter()
                .flat_map(|card| card.contests.clone())
                .collect(),
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct SessionBallot {
    precinct_portion_id: u32,
    ballot_type_id: u32,
    is_current: bool,
    contests: Option<Vec<ContestMarks>>,
    cards: Option<Vec<Card>>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct Card {
    id: u32,
    paper_index: u32,
    contests: Vec<ContestMarks>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "PascalCase")]
pub struct ContestMarks {
    pub id: u32,
    #[serde(deserialize_with = "deserialize_marks")]
    pub marks: Vec<Mark>,
}

fn deserialize_marks<'de, D>(deserializer: D) -> Result<Vec<Mark>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::{Error, Visitor};
    use std::fmt;

    struct MarksVisitor;

    impl<'de> Visitor<'de> for MarksVisitor {
        type Value = Vec<Mark>;

        fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
            formatter.write_str("array of marks or redacted string")
        }

        fn visit_str<E>(self, _value: &str) -> Result<Self::Value, E>
        where
            E: Error,
        {
            // Handle "*** REDACTED ***" or any other string as empty marks
            Ok(Vec::new())
        }

        fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
        where
            A: serde::de::SeqAccess<'de>,
        {
            let mut marks = Vec::new();
            while let Some(mark) = seq.next_element()? {
                marks.push(mark);
            }
            Ok(marks)
        }
    }

    deserializer.deserialize_any(MarksVisitor)
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "PascalCase")]
pub struct Mark {
    pub candidate_id: u32,
    party_id: Option<u32>,
    pub rank: u32,
    mark_density: u32,
    pub is_ambiguous: bool,
    is_vote: bool,
}

// CandidateManifest.json

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct CandidateManifest {
    version: String,
    pub list: Vec<Candidate>,
}

#[derive(Serialize, Deserialize)]
pub enum CandidateType {
    WriteIn,
    Regular,
    QualifiedWriteIn,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct Candidate {
    pub description: String,
    pub id: u32,
    external_id: Option<String>,
    pub contest_id: u32,

    #[serde(rename = "Type")]
    pub candidate_type: CandidateType,
}

// ContestManifest.json

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct ContestManifest {
    version: String,
    list: Vec<Contest>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct Contest {
    description: String,
    id: Option<u32>,
    external_id: Option<String>,
    vote_for: u32,
    num_of_ranks: u32,
}
